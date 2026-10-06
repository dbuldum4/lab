//! Whole-vault backup and restore, plus image conversion for Markdown files.
//!
//! The JSON format is the web app's `lab-local-vault` version 1, so a backup
//! made in either app restores in the other. Notes in the native vault refer
//! to images as `lab-asset://asset-…`, the same scheme the backup uses for its
//! asset table. Exported Markdown inlines images as `data:` URLs so a single
//! `.md` file stays portable.

use std::collections::HashMap;

use anyhow::{Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Serialize;
use serde_json::Value;

use crate::markdown_info::{is_valid_document_id, parse_fence};
use crate::search::regex;
use crate::vault::{DEFAULT_DOCUMENT_ID, SessionMeta, TitleSource, Vault, sniff_image_mime};

pub const BACKUP_FORMAT: &str = "lab-local-vault";
pub const BACKUP_VERSION: u64 = 1;
pub const BACKUP_FILENAME: &str = "lab-vault-backup.json";
pub const MAX_BACKUP_BYTES: usize = 64 * 1024 * 1024;
const ASSET_URI_PREFIX: &str = "lab-asset://";
const MAX_SESSIONS: usize = 2_000;
const MAX_ASSETS: usize = 10_000;
const MAX_MARKDOWN_CHARS: usize = 16 * 1024 * 1024;
const MAX_TOTAL_MARKDOWN_CHARS: usize = 64 * 1024 * 1024;
const MAX_DATA_URL_CHARS: usize = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Markdown outside code

/// Apply `transform` to ordinary Markdown text only. Fenced code blocks and
/// inline code spans stay literal.
pub fn transform_outside_code(markdown: &str, mut transform: impl FnMut(&str) -> String) -> String {
    fn find_run(line: &str, from: usize) -> Option<(usize, usize)> {
        let bytes = line.as_bytes();
        let start = from + line[from..].find('`')?;
        let mut end = start + 1;
        while end < bytes.len() && bytes[end] == b'`' {
            end += 1;
        }
        Some((start, end))
    }
    fn find_close(line: &str, from: usize, len: usize) -> Option<(usize, usize)> {
        let mut search = from;
        while let Some((start, end)) = find_run(line, search) {
            if end - start == len {
                return Some((start, end));
            }
            search = end;
        }
        None
    }

    let mut output = String::with_capacity(markdown.len());
    let mut fence: Option<crate::markdown_info::Fence> = None;
    let mut inline: Option<usize> = None;
    for (index, part) in markdown.split('\n').enumerate() {
        if index > 0 {
            output.push('\n');
        }
        let (line, cr) = match part.strip_suffix('\r') {
            Some(line) => (line, "\r"),
            None => (part, ""),
        };
        if let Some(open) = fence {
            output.push_str(part);
            if crate::markdown_info::closes_fence(line, open) {
                fence = None;
            }
            continue;
        }
        if inline.is_none()
            && let Some((opening, _)) = parse_fence(line)
        {
            output.push_str(part);
            fence = Some(opening);
            continue;
        }
        let mut cursor = 0;
        while cursor < line.len() {
            if let Some(len) = inline {
                match find_close(line, cursor, len) {
                    Some((_, end)) => {
                        output.push_str(&line[cursor..end]);
                        cursor = end;
                        inline = None;
                    }
                    None => {
                        output.push_str(&line[cursor..]);
                        cursor = line.len();
                    }
                }
                continue;
            }
            match find_run(line, cursor) {
                None => {
                    output.push_str(&transform(&line[cursor..]));
                    cursor = line.len();
                }
                Some((start, end)) => {
                    output.push_str(&transform(&line[cursor..start]));
                    match find_close(line, end, end - start) {
                        Some((_, close_end)) => {
                            output.push_str(&line[start..close_end]);
                            cursor = close_end;
                        }
                        None => {
                            inline = Some(end - start);
                            output.push_str(&line[start..]);
                            cursor = line.len();
                        }
                    }
                }
            }
        }
        output.push_str(cr);
    }
    output
}

fn replace_images(
    segment: &str,
    uri_pattern: &regex::Regex,
    mut replace: impl FnMut(&str) -> Option<String>,
) -> String {
    uri_pattern
        .replace_all(segment, |captures: &regex::Captures<'_>| {
            match replace(&captures[2]) {
                Some(uri) => format!("{}{}{}", &captures[1], uri, &captures[3]),
                None => captures[0].to_string(),
            }
        })
        .into_owned()
}

fn data_image_pattern() -> &'static regex::Regex {
    regex!(
        r#"(?i)(!\[(?:\\.|[^\]\\\r\n])*\]\(\s*)(data:image/[a-z0-9.+-]+(?:;[a-z0-9!#$&^_.+-]+)*,[^\s)]+)(\s*(?:"(?:[^"\\]|\\.)*")?\s*\))"#
    )
}

fn asset_image_pattern() -> &'static regex::Regex {
    regex!(
        r#"(!\[(?:\\.|[^\]\\\r\n])*\]\(\s*)(lab-asset://[a-z0-9_-]{1,64})(\s*(?:"(?:[^"\\]|\\.)*")?\s*\))"#
    )
}

/// Asset ids referenced by image destinations outside code.
pub fn referenced_assets(markdown: &str) -> Vec<String> {
    let mut ids = Vec::new();
    transform_outside_code(markdown, |segment| {
        for captures in asset_image_pattern().captures_iter(segment) {
            let id = captures[2][ASSET_URI_PREFIX.len()..].to_string();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        segment.to_string()
    });
    ids
}

// ---------------------------------------------------------------------------
// Data URLs

pub struct DataImage {
    pub mime: String,
    pub bytes: Vec<u8>,
    pub canonical: String,
}

fn percent_decode_bytes(value: &str) -> Option<Vec<u8>> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            out.push(u8::from_str_radix(value.get(index + 1..index + 3)?, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    Some(out)
}

fn signature_matches(mime: &str, bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    match mime {
        "image/png"
        | "image/jpeg"
        | "image/jpg"
        | "image/gif"
        | "image/webp"
        | "image/bmp"
        | "image/x-icon"
        | "image/vnd.microsoft.icon"
        | "image/svg+xml" => {
            let sniffed = sniff_image_mime(bytes);
            let expected = match mime {
                "image/jpg" => "image/jpeg",
                "image/vnd.microsoft.icon" => "image/x-icon",
                other => other,
            };
            sniffed == Some(expected)
        }
        _ => true,
    }
}

pub fn parse_data_image(value: &str) -> Option<DataImage> {
    if value.len() > MAX_DATA_URL_CHARS || !value.get(..11)?.eq_ignore_ascii_case("data:image/") {
        return None;
    }
    let comma = value.find(',')?;
    let header = &value[5..comma];
    let mut parts = header.split(';');
    let raw_mime = parts.next()?;
    if !regex!(r"(?i)^image/[a-z0-9.+-]+$").is_match(raw_mime) {
        return None;
    }
    let parameters: Vec<&str> = parts.collect();
    if parameters
        .iter()
        .any(|p| !regex!(r"(?i)^[a-z0-9!#$&^_.+-]+(?:=[a-z0-9!#$&^_.+-]*)?$").is_match(p))
    {
        return None;
    }
    let payload = &value[comma + 1..];
    if payload.is_empty() || payload.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return None;
    }
    let base64 = parameters.iter().any(|p| p.eq_ignore_ascii_case("base64"));
    let bytes = if base64 {
        if payload.len() % 4 == 1 || !regex!(r"(?i)^[a-z0-9+/]*={0,2}$").is_match(payload) {
            return None;
        }
        BASE64.decode(payload).ok()?
    } else {
        percent_decode_bytes(payload)?
    };
    let mime = raw_mime.to_lowercase();
    if !signature_matches(&mime, &bytes) {
        return None;
    }
    let canonical_params: Vec<String> = parameters
        .iter()
        .map(|p| {
            if p.eq_ignore_ascii_case("base64") {
                "base64".to_string()
            } else {
                p.to_string()
            }
        })
        .collect();
    let header = std::iter::once(mime.clone())
        .chain(canonical_params)
        .collect::<Vec<_>>()
        .join(";");
    Some(DataImage {
        mime,
        bytes,
        canonical: format!("data:{header},{payload}"),
    })
}

pub fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", BASE64.encode(bytes))
}

/// Move embedded `data:image/…` destinations into the vault's asset store.
pub fn externalize_data_images(markdown: &str, vault: &Vault) -> String {
    transform_outside_code(markdown, |segment| {
        replace_images(segment, data_image_pattern(), |url| {
            let image = parse_data_image(url)?;
            let id = vault.add_asset(&image.bytes, &image.mime).ok()?;
            Some(format!("{ASSET_URI_PREFIX}{id}"))
        })
    })
}

/// Replace `lab-asset://` destinations with portable `data:` URLs.
pub fn inline_assets(markdown: &str, vault: &Vault) -> String {
    transform_outside_code(markdown, |segment| {
        replace_images(segment, asset_image_pattern(), |uri| {
            let (bytes, mime) = vault.read_asset(&uri[ASSET_URI_PREFIX.len()..])?;
            Some(data_url(mime, &bytes))
        })
    })
}

// ---------------------------------------------------------------------------
// Backup

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupSession<'a> {
    id: &'a str,
    name: &'a str,
    title_source: TitleSource,
    pinned: bool,
    archived: bool,
    created_at: i64,
    updated_at: i64,
    markdown: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupAsset {
    id: String,
    data_url: String,
    mime_type: String,
}

#[derive(Serialize)]
struct Counts {
    sessions: usize,
    assets: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Backup<'a> {
    format: &'static str,
    version: u64,
    exported_at: i64,
    counts: Counts,
    sessions: Vec<BackupSession<'a>>,
    assets: Vec<BackupAsset>,
}

pub struct BackupSummary {
    pub json: String,
    pub sessions: usize,
    pub assets: usize,
}

/// Serialize every live session and the images it references.
pub fn build_backup(
    vault: &Vault,
    documents: &[(SessionMeta, String)],
    exported_at: i64,
) -> Result<BackupSummary> {
    if documents.len() > MAX_SESSIONS {
        bail!("The vault has too many sessions to export.");
    }
    let mut assets: Vec<BackupAsset> = Vec::new();
    let mut by_data_url: HashMap<String, String> = HashMap::new();
    let mut sorted: Vec<&(SessionMeta, String)> = documents.iter().collect();
    sorted.sort_by(|a, b| a.0.id.cmp(&b.0.id));
    let mut sessions = Vec::new();
    for (session, markdown) in sorted {
        // Local asset ids already satisfy the backup's id pattern, so they are
        // kept; any stray inline data URL gets its own numbered asset.
        let mut converted = transform_outside_code(markdown, |segment| {
            replace_images(segment, data_image_pattern(), |url| {
                let image = parse_data_image(url)?;
                let id = by_data_url
                    .entry(image.canonical.clone())
                    .or_insert_with(|| {
                        let id = format!("asset-inline-{}", assets.len() + 1);
                        assets.push(BackupAsset {
                            id: id.clone(),
                            data_url: image.canonical.clone(),
                            mime_type: image.mime.clone(),
                        });
                        id
                    });
                Some(format!("{ASSET_URI_PREFIX}{id}"))
            })
        });
        for id in referenced_assets(&converted) {
            if assets.iter().any(|asset| asset.id == id) {
                continue;
            }
            match vault.read_asset(&id) {
                Some((bytes, mime)) => assets.push(BackupAsset {
                    id: id.clone(),
                    data_url: data_url(mime, &bytes),
                    mime_type: mime.into(),
                }),
                None => {
                    // A missing file would make the backup unrestorable; keep
                    // the reference visible as plain text instead.
                    converted = converted
                        .replace(&format!("{ASSET_URI_PREFIX}{id}"), &format!("missing-{id}"));
                }
            }
        }
        sessions.push(BackupSession {
            id: &session.id,
            name: &session.name,
            title_source: session.title_source,
            pinned: session.pinned,
            archived: session.id != DEFAULT_DOCUMENT_ID && session.archived,
            created_at: session.created_at,
            updated_at: session.updated_at,
            markdown: converted,
        });
    }
    let backup = Backup {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at,
        counts: Counts {
            sessions: sessions.len(),
            assets: assets.len(),
        },
        sessions,
        assets,
    };
    let mut json = serde_json::to_string_pretty(&backup)?;
    json.push('\n');
    if json.len() > MAX_BACKUP_BYTES {
        bail!("The serialized vault backup is oversized.");
    }
    Ok(BackupSummary {
        json,
        sessions: backup.counts.sessions,
        assets: backup.counts.assets,
    })
}

// ---------------------------------------------------------------------------
// Restore

pub struct ParsedSession {
    pub meta: SessionMeta,
    pub markdown: String,
}

pub struct ParsedBackup {
    pub sessions: Vec<ParsedSession>,
    pub assets: HashMap<String, DataImage>,
}

fn invalid(message: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("Invalid lab vault backup: {message}")
}

fn timestamp(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number >= 0.0).then_some(number as i64)
}

/// Validate an untrusted backup completely before anything is written.
pub fn parse_backup(text: &str) -> Result<ParsedBackup> {
    if text.len() > MAX_BACKUP_BYTES {
        return Err(invalid("the backup file is oversized"));
    }
    let root: Value =
        serde_json::from_str(text).map_err(|_| invalid("the file is not valid JSON"))?;
    let root = root
        .as_object()
        .ok_or_else(|| invalid("the root value is not an object"))?;
    if root.get("format").and_then(Value::as_str) != Some(BACKUP_FORMAT) {
        return Err(invalid("the format is not supported"));
    }
    if root.get("version").and_then(Value::as_u64) != Some(BACKUP_VERSION) {
        return Err(invalid("the backup version is not supported"));
    }
    timestamp(root.get("exportedAt")).ok_or_else(|| invalid("the export timestamp is invalid"))?;
    let counts = root
        .get("counts")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("the backup counts are missing"))?;
    let raw_sessions = root
        .get("sessions")
        .and_then(Value::as_array)
        .filter(|s| s.len() <= MAX_SESSIONS)
        .ok_or_else(|| invalid("the sessions list is invalid"))?;
    let raw_assets = root
        .get("assets")
        .and_then(Value::as_array)
        .filter(|a| a.len() <= MAX_ASSETS)
        .ok_or_else(|| invalid("the image assets list is invalid"))?;
    if counts.get("sessions").and_then(Value::as_u64) != Some(raw_sessions.len() as u64)
        || counts.get("assets").and_then(Value::as_u64) != Some(raw_assets.len() as u64)
    {
        return Err(invalid("the manifest counts do not match the payload"));
    }

    let mut sessions: Vec<ParsedSession> = Vec::new();
    let mut total_markdown = 0;
    for (index, raw) in raw_sessions.iter().enumerate() {
        let object = raw
            .as_object()
            .ok_or_else(|| invalid(format!("session {} is not an object", index + 1)))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_valid_document_id(id))
            .ok_or_else(|| invalid(format!("session {} has an invalid id", index + 1)))?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| {
                name.chars().count() <= 80
                    && !name.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
            })
            .ok_or_else(|| invalid(format!("session {id} has an invalid name")))?;
        let title_source = match object.get("titleSource") {
            None => {
                if name.split_whitespace().collect::<Vec<_>>().join(" ") == "Untitled" {
                    TitleSource::Automatic
                } else {
                    TitleSource::Manual
                }
            }
            Some(Value::String(s)) if s == "automatic" => TitleSource::Automatic,
            Some(Value::String(s)) if s == "manual" => TitleSource::Manual,
            _ => return Err(invalid(format!("session {id} has an invalid title source"))),
        };
        let flag = |key: &str| -> Result<bool> {
            match object.get(key) {
                None => Ok(false),
                Some(Value::Bool(value)) => Ok(*value),
                _ => Err(invalid(format!("session {id} has an invalid {key} state"))),
            }
        };
        let pinned = flag("pinned")?;
        let archived = flag("archived")? && id != DEFAULT_DOCUMENT_ID;
        let (Some(created_at), Some(updated_at)) = (
            timestamp(object.get("createdAt")),
            timestamp(object.get("updatedAt")),
        ) else {
            return Err(invalid(format!("session {id} has invalid timestamps")));
        };
        let markdown = object
            .get("markdown")
            .and_then(Value::as_str)
            .filter(|m| m.len() <= MAX_MARKDOWN_CHARS)
            .ok_or_else(|| invalid(format!("session {id} has invalid or oversized Markdown")))?;
        total_markdown += markdown.len();
        if total_markdown > MAX_TOTAL_MARKDOWN_CHARS {
            return Err(invalid("the Markdown payload is oversized"));
        }
        if sessions.iter().any(|s| s.meta.id == id) {
            return Err(invalid(format!(
                "the session id {id} appears more than once"
            )));
        }
        sessions.push(ParsedSession {
            meta: SessionMeta {
                id: id.into(),
                name: name.into(),
                title_source,
                pinned,
                archived,
                created_at,
                updated_at,
            },
            markdown: markdown.into(),
        });
    }

    let mut assets: HashMap<String, DataImage> = HashMap::new();
    for (index, raw) in raw_assets.iter().enumerate() {
        let object = raw
            .as_object()
            .ok_or_else(|| invalid(format!("image asset {} is not an object", index + 1)))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| regex!(r"^asset-[a-z0-9_-]{1,64}$").is_match(id))
            .ok_or_else(|| invalid(format!("image asset {} has an invalid id", index + 1)))?;
        let image = object
            .get("dataUrl")
            .and_then(Value::as_str)
            .and_then(parse_data_image)
            .filter(|image| {
                object
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .map(str::to_lowercase)
                    .as_deref()
                    == Some(image.mime.as_str())
            })
            .ok_or_else(|| invalid(format!("image asset {id} is not a valid local image")))?;
        if assets.insert(id.to_string(), image).is_some() {
            return Err(invalid(format!(
                "the image asset id {id} appears more than once"
            )));
        }
    }
    for session in &sessions {
        for id in referenced_assets(&session.markdown) {
            if !assets.contains_key(&id) {
                return Err(invalid(format!(
                    "the Markdown references missing image asset {ASSET_URI_PREFIX}{id}"
                )));
            }
        }
    }
    Ok(ParsedBackup { sessions, assets })
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RestoreResult {
    pub imported: usize,
    pub skipped: usize,
    pub renamed: usize,
    pub assets: usize,
    pub active_document_updated: bool,
}

/// Merge a validated backup without replacing anything: exact copies are
/// skipped, conflicting or tombstoned ids get fresh ids, and an empty
/// original note may be filled. A failure rolls back this restore's writes.
pub fn restore_backup(
    vault: &mut Vault,
    backup: ParsedBackup,
    active_id: &str,
) -> Result<RestoreResult> {
    let mut result = RestoreResult {
        assets: backup.assets.len(),
        ..Default::default()
    };
    let mut local_ids: HashMap<String, String> = HashMap::new();
    for (backup_id, image) in &backup.assets {
        // Image types the asset store does not know stay inline as data URLs.
        if let Ok(local) = vault.add_asset(&image.bytes, &image.mime) {
            local_ids.insert(backup_id.clone(), local);
        }
    }

    let mut created: Vec<String> = Vec::new();
    let mut filled_default: Option<(SessionMeta, String)> = None;
    let outcome = (|| -> Result<()> {
        for session in &backup.sessions {
            let markdown = transform_outside_code(&session.markdown, |segment| {
                replace_images(segment, asset_image_pattern(), |uri| {
                    let id = &uri[ASSET_URI_PREFIX.len()..];
                    match local_ids.get(id) {
                        Some(local) => Some(format!("{ASSET_URI_PREFIX}{local}")),
                        None => backup.assets.get(id).map(|image| image.canonical.clone()),
                    }
                })
            });
            let existing = vault.session(&session.meta.id).cloned();
            let tombstoned = vault.is_deleted(&session.meta.id);
            let existing_markdown = existing
                .as_ref()
                .map(|_| vault.load(&session.meta.id).unwrap_or_default());
            if !tombstoned
                && existing.as_ref() == Some(&session.meta)
                && existing_markdown.as_deref() == Some(markdown.as_str())
            {
                result.skipped += 1;
                continue;
            }
            let fill_default = session.meta.id == DEFAULT_DOCUMENT_ID
                && existing_markdown.as_deref() == Some("")
                && existing.as_ref().is_some_and(|m| {
                    m.name == "Untitled" && m.title_source == TitleSource::Automatic
                });
            if fill_default {
                filled_default = existing.clone().map(|meta| (meta, String::new()));
                vault.put_session(session.meta.clone(), &markdown)?;
                result.imported += 1;
                result.active_document_updated |= active_id == DEFAULT_DOCUMENT_ID;
                continue;
            }
            let mut meta = session.meta.clone();
            if existing.is_some() || tombstoned {
                meta.id = vault.unused_session_id();
                result.renamed += 1;
            }
            vault.put_session(meta.clone(), &markdown)?;
            created.push(meta.id.clone());
            result.imported += 1;
            result.active_document_updated |= meta.id == active_id;
        }
        Ok(())
    })();

    if let Err(error) = outcome {
        let mut cleanup = Vec::new();
        for id in created.iter().rev() {
            if let Err(err) = vault.remove_session_for_rollback(id) {
                cleanup.push(err.to_string());
            }
        }
        if let Some((meta, markdown)) = filled_default
            && let Err(err) = vault.put_session(meta, &markdown)
        {
            cleanup.push(err.to_string());
        }
        let suffix = if cleanup.is_empty() {
            " All changes from this restore were rolled back.".to_string()
        } else {
            format!(" Cleanup was incomplete: {}", cleanup.join("; "))
        };
        bail!("Could not restore the backup: {error}.{suffix}");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::ArchiveFilter;

    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path().join("v")).unwrap();
        (dir, vault)
    }

    #[test]
    fn code_is_left_untouched() {
        let markdown = "a `x` b\n```\nc\n```\nd ``e`` f";
        let out = transform_outside_code(markdown, |s| s.to_uppercase());
        assert_eq!(out, "A `x` B\n```\nc\n```\nD ``e`` F");
        assert_eq!(
            transform_outside_code("a\r\nb", |s| s.to_uppercase()),
            "A\r\nB"
        );
    }

    #[test]
    fn data_urls_are_validated() {
        assert!(parse_data_image(PNG).is_some());
        assert!(parse_data_image("data:image/png;base64,AAAA").is_none());
        assert!(parse_data_image("data:text/html,hi").is_none());
        assert!(parse_data_image("data:image/svg+xml,%3Csvg%20xmlns%3D%22x%22%2F%3E").is_some());
    }

    #[test]
    fn images_round_trip_between_data_urls_and_assets() {
        let (_dir, vault) = vault();
        let markdown = format!("![dot]({PNG} \"t\")\n`![x]({PNG})`");
        let external = externalize_data_images(&markdown, &vault);
        assert!(external.starts_with("![dot](lab-asset://asset-"));
        assert!(external.ends_with(&format!("`![x]({PNG})`")));
        assert_eq!(referenced_assets(&external).len(), 1);
        assert_eq!(inline_assets(&external, &vault), markdown);
    }

    #[test]
    fn backup_round_trips_and_merges_without_replacing() {
        let (_dir, mut vault) = vault();
        let markdown = externalize_data_images(&format!("# Hi\n\n![dot]({PNG})"), &vault);
        vault.save(DEFAULT_DOCUMENT_ID, &markdown).unwrap();
        let other = vault.create_session().unwrap();
        vault.save(&other.id, "other").unwrap();
        vault.set_pinned(&other.id, true).unwrap();

        let documents = vault.all_documents();
        let backup = build_backup(&vault, &documents, 42).unwrap();
        assert_eq!((backup.sessions, backup.assets), (2, 1));
        let value: Value = serde_json::from_str(&backup.json).unwrap();
        assert_eq!(value["format"], "lab-local-vault");
        assert_eq!(value["sessions"][1]["titleSource"], "automatic");

        // Restoring into the same vault skips exact copies.
        let parsed = parse_backup(&backup.json).unwrap();
        let result = restore_backup(&mut vault, parsed, DEFAULT_DOCUMENT_ID).unwrap();
        assert_eq!((result.imported, result.skipped), (0, 2));

        // Restoring into a fresh vault fills the empty original note.
        let (_dir2, mut fresh) = super::tests::vault();
        let parsed = parse_backup(&backup.json).unwrap();
        let result = restore_backup(&mut fresh, parsed, DEFAULT_DOCUMENT_ID).unwrap();
        assert_eq!((result.imported, result.renamed), (2, 0));
        assert!(result.active_document_updated);
        let restored = fresh.load(DEFAULT_DOCUMENT_ID).unwrap();
        assert_eq!(
            inline_assets(&restored, &fresh),
            inline_assets(&markdown, &vault)
        );
        assert!(fresh.session(&other.id).unwrap().pinned);

        // A conflicting copy is imported under a new id.
        fresh.save(&other.id, "changed").unwrap();
        let parsed = parse_backup(&backup.json).unwrap();
        let result = restore_backup(&mut fresh, parsed, DEFAULT_DOCUMENT_ID).unwrap();
        assert_eq!((result.imported, result.renamed, result.skipped), (1, 1, 1));
        assert_eq!(fresh.sessions(ArchiveFilter::All).len(), 3);
    }

    #[test]
    fn deleted_ids_are_never_revived() {
        let (_dir, mut vault) = vault();
        let session = vault.create_session().unwrap();
        let documents = vault.all_documents();
        let json = build_backup(&vault, &documents, 1).unwrap().json;
        vault.delete(&session.id).unwrap();
        let result = restore_backup(
            &mut vault,
            parse_backup(&json).unwrap(),
            DEFAULT_DOCUMENT_ID,
        )
        .unwrap();
        assert_eq!(result.renamed, 1);
        assert!(vault.session(&session.id).is_none());
    }

    #[test]
    fn invalid_backups_are_rejected_before_writing() {
        let cases = [
            ("{", "not valid JSON"),
            (r#"{"format":"x"}"#, "format"),
            (r#"{"format":"lab-local-vault","version":2}"#, "version"),
            (
                r#"{"format":"lab-local-vault","version":1,"exportedAt":1,"counts":{"sessions":1,"assets":0},"sessions":[],"assets":[]}"#,
                "counts",
            ),
            (
                r#"{"format":"lab-local-vault","version":1,"exportedAt":1,"counts":{"sessions":2,"assets":0},"sessions":[{"id":"a","name":"A","createdAt":1,"updatedAt":1,"markdown":""},{"id":"a","name":"A","createdAt":1,"updatedAt":1,"markdown":""}],"assets":[]}"#,
                "more than once",
            ),
            (
                r#"{"format":"lab-local-vault","version":1,"exportedAt":1,"counts":{"sessions":1,"assets":0},"sessions":[{"id":"a","name":"A","createdAt":-1,"updatedAt":1,"markdown":""}],"assets":[]}"#,
                "timestamps",
            ),
            (
                r#"{"format":"lab-local-vault","version":1,"exportedAt":1,"counts":{"sessions":1,"assets":0},"sessions":[{"id":"a","name":"A","createdAt":1,"updatedAt":1,"markdown":"![x](lab-asset://asset-1)"}],"assets":[]}"#,
                "missing image",
            ),
        ];
        for (json, needle) in cases {
            let error = parse_backup(json).err().unwrap().to_string();
            assert!(error.contains(needle), "{error} should mention {needle}");
        }
    }
}
