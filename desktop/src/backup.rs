//! Whole-vault backup and restore, plus image conversion for Markdown files.
//!
//! The JSON format is the web app's `lab-local-vault` version 1, so a backup
//! made in either app restores in the other. Notes in the native vault refer
//! to images as `lab-asset://asset-…`, the same scheme the backup uses for its
//! asset table. Exported Markdown inlines images as `data:` URLs so a single
//! `.md` file stays portable.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use anyhow::{Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Serialize;
use serde_json::Value;

use crate::markdown_info::{code_ranges, is_valid_document_id};
use crate::search::regex;
use crate::vault::{
    DEFAULT_DOCUMENT_ID, SessionMeta, TitleSource, Vault, VaultSnapshot, load_note, note_file,
    sniff_image_mime, store_asset, unused_session_id, write_atomic,
};

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
    let mut output = String::with_capacity(markdown.len());
    let mut cursor = 0;
    for range in code_ranges(markdown) {
        output.push_str(&transform(&markdown[cursor..range.start]));
        output.push_str(&markdown[range.clone()]);
        cursor = range.end;
    }
    output.push_str(&transform(&markdown[cursor..]));
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
                    converted = transform_outside_code(&converted, |segment| {
                        replace_images(segment, asset_image_pattern(), |uri| {
                            (uri[ASSET_URI_PREFIX.len()..] == *id).then(|| format!("missing-{id}"))
                        })
                    });
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
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
/// The app runs the two halves on different threads.
#[cfg(test)]
pub fn restore_backup(
    vault: &mut Vault,
    backup: ParsedBackup,
    active_id: &str,
) -> Result<RestoreResult> {
    let prepared = prepare_restore(&vault.snapshot(), backup)?;
    finish_restore(vault, prepared, active_id)
}

/// A restore whose slow part is done. Images are stored and the notes of new
/// sessions are written, but the index does not list them yet. Dropping it
/// without [`finish_restore`] removes those notes.
pub struct PreparedRestore {
    root: PathBuf,
    created: Vec<SessionMeta>,
    fill_default: Option<FillDefault>,
    result: RestoreResult,
}

/// The backup's copy of the original note, which may fill it while it is
/// still empty and untitled.
struct FillDefault {
    meta: SessionMeta,
    markdown: String,
    /// The original note's metadata when the restore started.
    original: SessionMeta,
}

impl Drop for PreparedRestore {
    fn drop(&mut self) {
        for meta in &self.created {
            let _ = std::fs::remove_file(note_file(&self.root, &meta.id));
        }
    }
}

/// The slow part of a restore, safe to run off the UI thread: store the
/// images, compare with the existing notes, and write the new notes. Only
/// files are written; [`finish_restore`] updates the index.
pub fn prepare_restore(vault: &VaultSnapshot, backup: ParsedBackup) -> Result<PreparedRestore> {
    let mut prepared = PreparedRestore {
        root: vault.root.clone(),
        created: Vec::new(),
        fill_default: None,
        result: RestoreResult {
            assets: backup.assets.len(),
            ..Default::default()
        },
    };
    let mut local_ids: HashMap<String, String> = HashMap::new();
    for (backup_id, image) in &backup.assets {
        // Image types the asset store does not know stay inline as data URLs.
        if let Ok(local) = store_asset(&vault.root, &image.bytes, &image.mime) {
            local_ids.insert(backup_id.clone(), local);
        }
    }

    let mut taken: HashSet<String> = HashSet::new();
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
        // A note that cannot be read is never treated as empty, so it is
        // neither skipped nor overwritten; the backup copy gets a new id.
        let existing_markdown = existing
            .as_ref()
            .and_then(|_| load_note(&vault.root, &session.meta.id).ok());
        if !tombstoned
            && existing.as_ref() == Some(&session.meta)
            && existing_markdown.as_deref() == Some(markdown.as_str())
        {
            prepared.result.skipped += 1;
            continue;
        }
        if let Some(original) = existing.as_ref().filter(|meta| {
            meta.id == DEFAULT_DOCUMENT_ID
                && meta.name == "Untitled"
                && meta.title_source == TitleSource::Automatic
                && existing_markdown.as_deref() == Some("")
                && prepared.fill_default.is_none()
        }) {
            prepared.fill_default = Some(FillDefault {
                meta: session.meta.clone(),
                markdown,
                original: original.clone(),
            });
            prepared.result.imported += 1;
            continue;
        }
        let mut meta = session.meta.clone();
        if existing.is_some() || tombstoned || taken.contains(&meta.id) {
            meta.id = unused_session_id(|id| {
                vault.session(id).is_some() || vault.is_deleted(id) || taken.contains(id)
            });
            prepared.result.renamed += 1;
        }
        taken.insert(meta.id.clone());
        let path = note_file(&vault.root, &meta.id);
        prepared.created.push(meta);
        if let Err(error) = write_atomic(&path, markdown.as_bytes()) {
            // Dropping `prepared` removes the notes written so far.
            bail!(
                "Could not restore the backup: {error}. All changes from this restore were rolled back."
            );
        }
        prepared.result.imported += 1;
    }
    Ok(prepared)
}

/// Add a prepared restore's sessions to the index with one write. The vault
/// may have changed since [`prepare_restore`] ran: an original note that is
/// no longer empty keeps its text, and the backup copy gets a new id.
pub fn finish_restore(
    vault: &mut Vault,
    mut prepared: PreparedRestore,
    active_id: &str,
) -> Result<RestoreResult> {
    if prepared
        .created
        .iter()
        .any(|meta| vault.session(&meta.id).is_some() || vault.is_deleted(&meta.id))
    {
        // Another session took one of the new ids. Its note is no longer
        // ours to remove.
        prepared
            .created
            .retain(|meta| vault.session(&meta.id).is_none());
        bail!(
            "Could not restore the backup: the vault changed while it ran. Nothing was restored."
        );
    }
    let mut created = std::mem::take(&mut prepared.created);
    let mut result = std::mem::take(&mut prepared.result);
    let mut filled: Option<SessionMeta> = None;

    let outcome = (|| -> Result<()> {
        if let Some(fill) = prepared.fill_default.take() {
            let unchanged = vault.session(DEFAULT_DOCUMENT_ID) == Some(&fill.original)
                && vault.load(DEFAULT_DOCUMENT_ID).ok().as_deref() == Some("");
            if unchanged {
                vault.stage_session(fill.meta, &fill.markdown)?;
                filled = Some(fill.original);
                result.active_document_updated = active_id == DEFAULT_DOCUMENT_ID;
            } else {
                let mut meta = fill.meta;
                meta.id =
                    unused_session_id(|id| vault.session(id).is_some() || vault.is_deleted(id));
                result.renamed += 1;
                created.push(meta.clone());
                vault.stage_session(meta, &fill.markdown)?;
            }
        }
        for meta in &created {
            vault.index_session(meta.clone());
        }
        vault.commit_index()
    })();

    if let Err(error) = outcome {
        let mut cleanup = Vec::new();
        for meta in created.iter().rev() {
            vault.unstage_session(&meta.id);
        }
        if let Some(original) = filled
            && let Err(err) = vault.stage_session(original, "")
        {
            cleanup.push(err.to_string());
        }
        if let Err(err) = vault.commit_index() {
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
    fn a_stray_backtick_does_not_hide_later_images() {
        let markdown = "don`t forget\n\n![img](lab-asset://asset-1)\n\nsee `code`";
        assert_eq!(referenced_assets(markdown), ["asset-1"]);
        assert_eq!(
            transform_outside_code(markdown, |s| s.to_uppercase()),
            "DON`T FORGET\n\n![IMG](LAB-ASSET://ASSET-1)\n\nSEE `code`"
        );
        // A code span may still wrap a line within one paragraph.
        assert_eq!(
            transform_outside_code("a `b\nc` d", |s| s.to_uppercase()),
            "A `b\nc` D"
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
    fn missing_assets_are_renamed_exactly_and_outside_code_only() {
        let (_dir, mut vault) = vault();
        let present = externalize_data_images(&format!("![b]({PNG})"), &vault);
        let present_id = &referenced_assets(&present)[0];
        let missing_id = &present_id[..present_id.len() - 2];
        let markdown =
            format!("![a](lab-asset://{missing_id})\n{present}\n`lab-asset://{missing_id}`");
        vault.save(DEFAULT_DOCUMENT_ID, &markdown).unwrap();
        let backup = build_backup(&vault, &vault.all_documents(), 1).unwrap();
        assert_eq!(backup.assets, 1);
        let value: Value = serde_json::from_str(&backup.json).unwrap();
        assert_eq!(
            value["sessions"][0]["markdown"],
            format!("![a](missing-{missing_id})\n{present}\n`lab-asset://{missing_id}`")
        );
    }

    #[test]
    fn restore_never_overwrites_a_note_it_cannot_read() {
        let (_dir, mut source) = vault();
        source.save(DEFAULT_DOCUMENT_ID, "from backup").unwrap();
        let json = build_backup(&source, &source.all_documents(), 1)
            .unwrap()
            .json;

        let (_dir2, mut vault) = vault();
        let path = vault
            .root()
            .join("notes")
            .join(format!("{DEFAULT_DOCUMENT_ID}.md"));
        std::fs::write(&path, b"\xff\xfe not utf-8").unwrap();
        let result = restore_backup(
            &mut vault,
            parse_backup(&json).unwrap(),
            DEFAULT_DOCUMENT_ID,
        )
        .unwrap();
        assert_eq!((result.imported, result.renamed), (1, 1));
        assert_eq!(std::fs::read(&path).unwrap(), b"\xff\xfe not utf-8");
    }

    #[test]
    fn prepared_restores_touch_only_files_until_finished() {
        let (_dir, mut source) = vault();
        let session = source.create_session().unwrap();
        source.save(&session.id, "from backup").unwrap();
        let json = build_backup(&source, &source.all_documents(), 1)
            .unwrap()
            .json;

        let (_dir2, mut vault) = vault();
        let note = vault
            .root()
            .join("notes")
            .join(format!("{}.md", session.id));
        let prepared = prepare_restore(&vault.snapshot(), parse_backup(&json).unwrap()).unwrap();
        assert!(note.exists());
        assert!(vault.session(&session.id).is_none());
        // Dropping an unfinished restore removes its notes.
        drop(prepared);
        assert!(!note.exists());

        let prepared = prepare_restore(&vault.snapshot(), parse_backup(&json).unwrap()).unwrap();
        let result = finish_restore(&mut vault, prepared, DEFAULT_DOCUMENT_ID).unwrap();
        // The backup's empty original note fills this vault's empty one.
        assert_eq!((result.imported, result.renamed), (2, 0));
        assert_eq!(vault.load(&session.id).unwrap(), "from backup");
    }

    #[test]
    fn an_original_note_edited_during_a_restore_keeps_its_text() {
        let (_dir, mut source) = vault();
        source.save(DEFAULT_DOCUMENT_ID, "from backup").unwrap();
        let json = build_backup(&source, &source.all_documents(), 1)
            .unwrap()
            .json;

        let (_dir2, mut vault) = vault();
        let prepared = prepare_restore(&vault.snapshot(), parse_backup(&json).unwrap()).unwrap();
        vault.save(DEFAULT_DOCUMENT_ID, "typed meanwhile").unwrap();
        let result = finish_restore(&mut vault, prepared, DEFAULT_DOCUMENT_ID).unwrap();
        assert_eq!((result.imported, result.renamed), (1, 1));
        assert!(!result.active_document_updated);
        assert_eq!(vault.load(DEFAULT_DOCUMENT_ID).unwrap(), "typed meanwhile");
        let copy = vault
            .sessions(ArchiveFilter::All)
            .into_iter()
            .find(|meta| meta.id != DEFAULT_DOCUMENT_ID)
            .unwrap();
        assert_eq!(vault.load(&copy.id).unwrap(), "from backup");
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
