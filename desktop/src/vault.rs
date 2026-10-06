//! The local vault: one Markdown file per session plus a small JSON index.
//!
//! Layout under the vault root:
//!
//! ```text
//! vault.json            session metadata, tombstones, and preferences
//! notes/<id>.md         the Markdown for each session
//! history/<id>.json     bounded version history per session
//! assets/<id>.<ext>     images, deduplicated by content hash
//! ```
//!
//! Every write goes to a temporary file that is flushed and renamed into
//! place, so a crash leaves either the old or the new file, never a torn one.
//! The web app needed redundant browser stores to survive eviction; a native
//! file system does not evict, so a single atomic copy is the honest design.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::markdown_info::{automatic_title, is_valid_document_id};

pub const DEFAULT_DOCUMENT_ID: &str = "default";
pub const HISTORY_MAX_ENTRIES: usize = 50;
pub const HISTORY_MAX_BYTES: usize = 1024 * 1024;
pub const HISTORY_MAX_MARKDOWN_BYTES: usize = 512 * 1024;
/// Automatic snapshots are taken at most this often while typing. Destructive
/// actions (clear, import, restore) always snapshot first.
pub const HISTORY_MIN_INTERVAL_MS: i64 = 60_000;
const INDEX_VERSION: u32 = 1;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleSource {
    Automatic,
    Manual,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub name: String,
    pub title_source: TitleSource,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveFilter {
    Active,
    Archived,
    All,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Index {
    version: u32,
    sessions: Vec<SessionMeta>,
    /// Permanently deleted ids. Restore never revives them.
    deleted: Vec<String>,
    theme: Option<String>,
    last_session: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub id: String,
    pub created_at: i64,
    pub markdown: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryFile {
    schema_version: u32,
    document_id: String,
    entries: Vec<VersionEntry>,
}

pub struct VaultStatus {
    pub root: PathBuf,
    pub active: usize,
    pub archived: usize,
    pub note_bytes: u64,
    pub history_bytes: u64,
    pub asset_count: usize,
    pub asset_bytes: u64,
}

pub fn normalize_name(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated: String = collapsed
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    let trimmed = truncated.trim();
    if trimmed.is_empty() {
        "Untitled".into()
    } else {
        trimmed.to_string()
    }
}

/// Write `bytes` to `path` atomically: temp file, fsync, rename, fsync dir.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent", path.display()))?;
    fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let temp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    {
        let mut file =
            File::create(&temp).with_context(|| format!("creating {}", temp.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&temp, path).with_context(|| format!("replacing {}", path.display()))?;
    #[cfg(unix)]
    if let Ok(dir) = File::open(dir) {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn random_hex(bytes: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    let mut counter = 0u64;
    while out.len() < bytes * 2 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(counter);
        hasher.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", hasher.finish()));
        counter += 1;
    }
    out.truncate(bytes * 2);
    out
}

fn new_session_id() -> String {
    format!("{}{}", radix36(now_ms() as u64), random_hex(8))
}

fn radix36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

fn short_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest[..6].iter().map(|b| format!("{b:02x}")).collect()
}

pub struct Vault {
    root: PathBuf,
    index: Index,
    /// Newest snapshot time per session, so autosave does not re-read history.
    latest_version: std::collections::HashMap<String, i64>,
    /// Set when an autosave snapshot fails after succeeding before, so the
    /// app warns once instead of on every save.
    history_error: Option<String>,
    history_failing: bool,
    /// Held for the vault's lifetime so two app instances cannot interleave writes.
    _lock: File,
}

impl Vault {
    /// `LAB_VAULT_DIR` overrides the platform data directory.
    pub fn default_root() -> PathBuf {
        if let Some(dir) = std::env::var_os("LAB_VAULT_DIR") {
            return PathBuf::from(dir);
        }
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("lab")
    }

    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        for dir in ["notes", "history", "assets"] {
            fs::create_dir_all(root.join(dir))
                .with_context(|| format!("creating {}", root.display()))?;
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(root.join(".lock"))?;
        if lock.try_lock().is_err() {
            bail!(
                "Another lab window is using the vault at {}.",
                root.display()
            );
        }

        let index_path = root.join("vault.json");
        let mut index: Index = match fs::read(&index_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("{} is not a valid lab index", index_path.display()))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Index::default(),
            Err(err) => return Err(err.into()),
        };
        index.version = INDEX_VERSION;
        index
            .sessions
            .retain(|session| is_valid_document_id(&session.id));
        let mut vault = Self {
            root,
            index,
            latest_version: Default::default(),
            history_error: None,
            history_failing: false,
            _lock: lock,
        };
        if vault.session(DEFAULT_DOCUMENT_ID).is_none() {
            let now = now_ms();
            vault.index.sessions.push(SessionMeta {
                id: DEFAULT_DOCUMENT_ID.into(),
                name: "Untitled".into(),
                title_source: TitleSource::Automatic,
                pinned: false,
                archived: false,
                created_at: now,
                updated_at: 0,
            });
            vault.write_index()?;
        }
        Ok(vault)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn write_index(&self) -> Result<()> {
        let json = serde_json::to_vec_pretty(&self.index)?;
        write_atomic(&self.root.join("vault.json"), &json)
    }

    fn note_path(&self, id: &str) -> PathBuf {
        self.root.join("notes").join(format!("{id}.md"))
    }

    fn history_path(&self, id: &str) -> PathBuf {
        self.root.join("history").join(format!("{id}.json"))
    }

    // -- Preferences -------------------------------------------------------

    pub fn theme(&self) -> Option<&str> {
        self.index.theme.as_deref()
    }

    pub fn set_theme(&mut self, theme: &str) -> Result<()> {
        self.index.theme = Some(theme.to_string());
        self.write_index()
    }

    pub fn last_session(&self) -> &str {
        self.index
            .last_session
            .as_deref()
            .filter(|id| self.session(id).is_some())
            .unwrap_or(DEFAULT_DOCUMENT_ID)
    }

    pub fn set_last_session(&mut self, id: &str) -> Result<()> {
        if self.index.last_session.as_deref() == Some(id) {
            return Ok(());
        }
        self.index.last_session = Some(id.to_string());
        self.write_index()
    }

    // -- Sessions ----------------------------------------------------------

    pub fn session(&self, id: &str) -> Option<&SessionMeta> {
        self.index.sessions.iter().find(|session| session.id == id)
    }

    fn session_mut(&mut self, id: &str) -> Result<&mut SessionMeta> {
        self.index
            .sessions
            .iter_mut()
            .find(|session| session.id == id)
            .ok_or_else(|| anyhow!("Session {id} no longer exists."))
    }

    pub fn is_deleted(&self, id: &str) -> bool {
        self.index.deleted.iter().any(|deleted| deleted == id)
    }

    /// Pinned first, then most recently updated, then by name.
    pub fn sessions(&self, filter: ArchiveFilter) -> Vec<SessionMeta> {
        let mut sessions: Vec<SessionMeta> = self
            .index
            .sessions
            .iter()
            .filter(|session| match filter {
                ArchiveFilter::Active => !session.archived,
                ArchiveFilter::Archived => session.archived,
                ArchiveFilter::All => true,
            })
            .cloned()
            .collect();
        sessions.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then(b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.id.cmp(&b.id))
        });
        sessions
    }

    pub fn create_session(&mut self) -> Result<SessionMeta> {
        let id = loop {
            let candidate = new_session_id();
            if self.session(&candidate).is_none() && !self.is_deleted(&candidate) {
                break candidate;
            }
        };
        let now = now_ms();
        let session = SessionMeta {
            id,
            name: "Untitled".into(),
            title_source: TitleSource::Automatic,
            pinned: false,
            archived: false,
            created_at: now,
            updated_at: now,
        };
        write_atomic(&self.note_path(&session.id), b"")?;
        self.index.sessions.push(session.clone());
        self.write_index()?;
        Ok(session)
    }

    pub fn load(&self, id: &str) -> Result<String> {
        match fs::read(self.note_path(id)) {
            Ok(bytes) => {
                String::from_utf8(bytes).map_err(|_| anyhow!("Session {id} is not valid UTF-8."))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(err) => Err(err.into()),
        }
    }

    /// Persist a note, refresh its timestamp and automatic title, and take a
    /// version snapshot when the last one is old enough. A failed snapshot
    /// does not fail the save; see [`Vault::take_history_error`].
    pub fn save(&mut self, id: &str, markdown: &str) -> Result<SessionMeta> {
        if self.session(id).is_none() {
            bail!("Session {id} no longer exists.");
        }
        write_atomic(&self.note_path(id), markdown.as_bytes())?;
        let now = now_ms();
        let title = automatic_title(markdown);
        let session = self.session_mut(id)?;
        session.updated_at = now;
        if session.title_source == TitleSource::Automatic {
            session.name = normalize_name(&title);
        }
        let session = session.clone();
        self.write_index()?;

        let latest = match self.latest_version.get(id) {
            Some(latest) => *latest,
            None => self
                .versions(id)
                .first()
                .map_or(0, |entry| entry.created_at),
        };
        if now - latest >= HISTORY_MIN_INTERVAL_MS {
            match self.record_version(id, markdown, now) {
                Ok(_) => self.history_failing = false,
                Err(err) => {
                    // Wait the usual interval before trying again.
                    self.latest_version.insert(id.to_string(), now);
                    if !self.history_failing {
                        self.history_failing = true;
                        self.history_error = Some(err.to_string());
                    }
                }
            }
        }
        Ok(session)
    }

    /// The error from a snapshot that failed during [`Vault::save`], once.
    pub fn take_history_error(&mut self) -> Option<String> {
        self.history_error.take()
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<SessionMeta> {
        let session = self.session_mut(id)?;
        session.name = normalize_name(name);
        session.title_source = TitleSource::Manual;
        let session = session.clone();
        self.write_index()?;
        Ok(session)
    }

    pub fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<SessionMeta> {
        let session = self.session_mut(id)?;
        session.pinned = pinned;
        let session = session.clone();
        self.write_index()?;
        Ok(session)
    }

    pub fn set_archived(&mut self, id: &str, archived: bool) -> Result<SessionMeta> {
        if archived && id == DEFAULT_DOCUMENT_ID {
            bail!("The original session cannot be archived.");
        }
        let session = self.session_mut(id)?;
        session.archived = archived;
        let session = session.clone();
        self.write_index()?;
        Ok(session)
    }

    pub fn delete(&mut self, id: &str) -> Result<()> {
        if id == DEFAULT_DOCUMENT_ID {
            bail!("The original session cannot be deleted. Use /clear to empty it.");
        }
        self.index.sessions.retain(|session| session.id != id);
        if !self.is_deleted(id) {
            self.index.deleted.push(id.to_string());
        }
        if self.index.last_session.as_deref() == Some(id) {
            self.index.last_session = None;
        }
        self.latest_version.remove(id);
        self.write_index()?;
        for path in [self.note_path(id), self.history_path(id)] {
            match fs::remove_file(&path) {
                Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.into()),
                _ => {}
            }
        }
        Ok(())
    }

    /// Write a session's note and add or replace its metadata in memory
    /// (used by restore). [`Vault::commit_index`] makes the change durable,
    /// so a batch of sessions writes the index once.
    pub(crate) fn stage_session(&mut self, session: SessionMeta, markdown: &str) -> Result<()> {
        write_atomic(&self.note_path(&session.id), markdown.as_bytes())?;
        match self
            .index
            .sessions
            .iter_mut()
            .find(|existing| existing.id == session.id)
        {
            Some(existing) => *existing = session,
            None => self.index.sessions.push(session),
        }
        Ok(())
    }

    /// Undo [`Vault::stage_session`] for a session that did not exist before.
    pub(crate) fn unstage_session(&mut self, id: &str) {
        self.index.sessions.retain(|session| session.id != id);
        let _ = fs::remove_file(self.note_path(id));
    }

    pub(crate) fn commit_index(&self) -> Result<()> {
        self.write_index()
    }

    pub(crate) fn unused_session_id(&self) -> String {
        loop {
            let candidate = new_session_id();
            if self.session(&candidate).is_none() && !self.is_deleted(&candidate) {
                return candidate;
            }
        }
    }

    // -- Version history ---------------------------------------------------

    fn read_history(&self, id: &str) -> Vec<VersionEntry> {
        fs::read(self.history_path(id))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<HistoryFile>(&bytes).ok())
            .filter(|file| file.document_id == id)
            .map(|file| file.entries)
            .unwrap_or_default()
    }

    /// Valid snapshots, newest first.
    pub fn versions(&self, id: &str) -> Vec<VersionEntry> {
        let mut entries = self.read_history(id);
        entries.reverse();
        entries
    }

    /// Store a snapshot unless the same Markdown is already in history.
    pub fn record_version(
        &mut self,
        id: &str,
        markdown: &str,
        now: i64,
    ) -> Result<Option<VersionEntry>> {
        if markdown.len() > HISTORY_MAX_MARKDOWN_BYTES {
            return Ok(None);
        }
        let mut entries = self.read_history(id);
        if entries.iter().any(|entry| entry.markdown == markdown) {
            // Unchanged content still counts as a fresh snapshot.
            self.latest_version.insert(id.to_string(), now);
            return Ok(None);
        }
        let base = format!("v{}-{}", radix36(now.max(0) as u64), short_hash(markdown));
        let mut entry_id = base.clone();
        let mut suffix = 1u64;
        while entries.iter().any(|entry| entry.id == entry_id) {
            entry_id = format!("{base}-{}", radix36(suffix));
            suffix += 1;
        }
        let entry = VersionEntry {
            id: entry_id,
            created_at: now,
            markdown: markdown.to_string(),
        };
        entries.push(entry.clone());
        while entries.len() > HISTORY_MAX_ENTRIES
            || entries
                .iter()
                .map(|entry| entry.markdown.len())
                .sum::<usize>()
                > HISTORY_MAX_BYTES
        {
            entries.remove(0);
        }
        if !entries.iter().any(|candidate| candidate.id == entry.id) {
            return Ok(None);
        }
        let file = HistoryFile {
            schema_version: 1,
            document_id: id.to_string(),
            entries,
        };
        write_atomic(&self.history_path(id), &serde_json::to_vec(&file)?)?;
        self.latest_version.insert(id.to_string(), now);
        Ok(Some(entry))
    }

    // -- Assets ------------------------------------------------------------

    /// Store image bytes once, keyed by content hash. Returns the asset id.
    pub fn add_asset(&self, bytes: &[u8], mime: &str) -> Result<String> {
        let ext =
            extension_for_mime(mime).ok_or_else(|| anyhow!("Unsupported image type {mime}."))?;
        let digest = Sha256::digest(bytes);
        let id = format!(
            "asset-{}",
            digest[..16]
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let path = self.root.join("assets").join(format!("{id}.{ext}"));
        if !path.exists() {
            write_atomic(&path, bytes)?;
        }
        Ok(id)
    }

    pub fn asset_path(&self, id: &str) -> Option<PathBuf> {
        asset_file(&self.root, id)
    }

    pub fn read_asset(&self, id: &str) -> Option<(Vec<u8>, &'static str)> {
        let path = self.asset_path(id)?;
        let ext = path.extension()?.to_str()?;
        let mime = MIME_EXTENSIONS.iter().find(|(_, e)| *e == ext)?.0;
        Some((fs::read(&path).ok()?, mime))
    }

    // -- Status ------------------------------------------------------------

    pub fn status(&self) -> VaultStatus {
        let dir_size = |dir: &str| -> (usize, u64) {
            fs::read_dir(self.root.join(dir))
                .map(|entries| {
                    entries
                        .filter_map(|entry| entry.ok()?.metadata().ok())
                        .filter(|meta| meta.is_file())
                        .fold((0, 0), |(count, bytes), meta| {
                            (count + 1, bytes + meta.len())
                        })
                })
                .unwrap_or((0, 0))
        };
        let (_, note_bytes) = dir_size("notes");
        let (_, history_bytes) = dir_size("history");
        let (asset_count, asset_bytes) = dir_size("assets");
        VaultStatus {
            root: self.root.clone(),
            active: self.index.sessions.iter().filter(|s| !s.archived).count(),
            archived: self.index.sessions.iter().filter(|s| s.archived).count(),
            note_bytes,
            history_bytes,
            asset_count,
            asset_bytes,
        }
    }

    /// Every live session with its Markdown (search, backlinks, backup).
    pub fn all_documents(&self) -> Vec<(SessionMeta, String)> {
        self.sessions(ArchiveFilter::All)
            .into_iter()
            .map(|session| {
                let markdown = self.load(&session.id).unwrap_or_default();
                (session, markdown)
            })
            .collect()
    }
}

pub const MIME_EXTENSIONS: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/bmp", "bmp"),
    ("image/svg+xml", "svg"),
    ("image/x-icon", "ico"),
];

pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    let mime = if mime == "image/jpg" {
        "image/jpeg"
    } else {
        mime
    };
    MIME_EXTENSIONS
        .iter()
        .find(|(m, _)| *m == mime)
        .map(|(_, ext)| *ext)
}

/// Sniff an image type from its leading bytes.
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else {
        let text = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
        let text = text.trim_start_matches('\u{feff}').trim_start();
        let text = if text.starts_with("<?xml") {
            text.split_once("?>")
                .map_or("", |(_, rest)| rest)
                .trim_start()
        } else {
            text
        };
        (text.starts_with("<svg ") || text.starts_with("<svg>") || text.starts_with("<svg\n"))
            .then_some("image/svg+xml")
    }
}

/// The stored file for an asset id in the vault at `root`, if it exists.
pub fn asset_file(root: &Path, id: &str) -> Option<PathBuf> {
    let valid = id.strip_prefix("asset-").is_some_and(|rest| {
        rest.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    });
    if !valid {
        return None;
    }
    MIME_EXTENSIONS
        .iter()
        .map(|(_, ext)| root.join("assets").join(format!("{id}.{ext}")))
        .find(|path| path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path().join("vault")).unwrap();
        (dir, vault)
    }

    #[test]
    fn opens_with_a_default_session_and_reopens_state() {
        let (dir, mut vault) = vault();
        assert_eq!(vault.sessions(ArchiveFilter::All).len(), 1);
        vault.save(DEFAULT_DOCUMENT_ID, "# Hello\n\nworld").unwrap();
        vault.set_theme("nord").unwrap();
        let root = vault.root().to_path_buf();
        drop(vault);
        let reopened = Vault::open(&root).unwrap();
        assert_eq!(
            reopened.load(DEFAULT_DOCUMENT_ID).unwrap(),
            "# Hello\n\nworld"
        );
        assert_eq!(reopened.session(DEFAULT_DOCUMENT_ID).unwrap().name, "Hello");
        assert_eq!(reopened.theme(), Some("nord"));
        drop(dir);
    }

    #[test]
    fn a_second_instance_cannot_open_the_same_vault() {
        let (_dir, vault) = vault();
        assert!(Vault::open(vault.root()).is_err());
    }

    #[test]
    fn manual_names_are_never_overwritten() {
        let (_dir, mut vault) = vault();
        let session = vault.create_session().unwrap();
        vault.rename(&session.id, "  My   plan ").unwrap();
        let saved = vault.save(&session.id, "# Different").unwrap();
        assert_eq!(saved.name, "My plan");
        assert_eq!(saved.title_source, TitleSource::Manual);
    }

    #[test]
    fn sessions_sort_pinned_first_then_recent() {
        let (_dir, mut vault) = vault();
        let a = vault.create_session().unwrap();
        let b = vault.create_session().unwrap();
        vault.save(&a.id, "a").unwrap();
        vault.set_pinned(&b.id, true).unwrap();
        let order: Vec<String> = vault
            .sessions(ArchiveFilter::Active)
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(order[0], b.id);
        assert_eq!(order[1], a.id);
    }

    #[test]
    fn archive_and_delete_rules() {
        let (_dir, mut vault) = vault();
        assert!(vault.set_archived(DEFAULT_DOCUMENT_ID, true).is_err());
        assert!(vault.delete(DEFAULT_DOCUMENT_ID).is_err());
        let session = vault.create_session().unwrap();
        vault.set_archived(&session.id, true).unwrap();
        assert_eq!(vault.sessions(ArchiveFilter::Archived).len(), 1);
        assert_eq!(vault.sessions(ArchiveFilter::Active).len(), 1);
        vault.save(&session.id, "bye").unwrap();
        vault.delete(&session.id).unwrap();
        assert!(vault.is_deleted(&session.id));
        assert!(vault.versions(&session.id).is_empty());
        assert!(vault.save(&session.id, "x").is_err());
    }

    #[test]
    fn history_is_deduplicated_and_bounded() {
        let (_dir, mut vault) = vault();
        let id = DEFAULT_DOCUMENT_ID;
        assert!(vault.record_version(id, "one", 1).unwrap().is_some());
        assert!(vault.record_version(id, "one", 2).unwrap().is_none());
        for n in 0..60 {
            vault.record_version(id, &format!("v{n}"), 10 + n).unwrap();
        }
        let versions = vault.versions(id);
        assert_eq!(versions.len(), HISTORY_MAX_ENTRIES);
        assert_eq!(versions[0].markdown, "v59");
        let big = "x".repeat(400 * 1024);
        vault.record_version(id, &format!("{big}1"), 100).unwrap();
        vault.record_version(id, &format!("{big}2"), 101).unwrap();
        vault.record_version(id, &format!("{big}3"), 102).unwrap();
        let total: usize = vault.versions(id).iter().map(|v| v.markdown.len()).sum();
        assert!(total <= HISTORY_MAX_BYTES);
        assert!(
            vault
                .record_version(id, &"y".repeat(600 * 1024), 103)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_failed_snapshot_does_not_fail_the_save() {
        let (_dir, mut vault) = vault();
        let session = vault.create_session().unwrap();
        // A directory where the history file belongs makes snapshots fail.
        fs::create_dir_all(vault.history_path(&session.id).join("blocked")).unwrap();
        let saved = vault.save(&session.id, "# Kept").unwrap();
        assert_eq!(saved.name, "Kept");
        assert_eq!(vault.load(&session.id).unwrap(), "# Kept");
        assert!(vault.take_history_error().is_some());
        // The warning is given once, not on every save.
        vault.latest_version.clear();
        vault.save(&session.id, "# Kept again").unwrap();
        assert!(vault.take_history_error().is_none());
        let root = vault.root().to_path_buf();
        drop(vault);
        let reopened = Vault::open(&root).unwrap();
        assert_eq!(reopened.session(&session.id).unwrap().name, "Kept again");
    }

    #[test]
    fn assets_are_content_addressed() {
        let (_dir, vault) = vault();
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        assert_eq!(sniff_image_mime(&png), Some("image/png"));
        let first = vault.add_asset(&png, "image/png").unwrap();
        let second = vault.add_asset(&png, "image/png").unwrap();
        assert_eq!(first, second);
        assert_eq!(vault.read_asset(&first).unwrap().0, png);
        assert!(vault.asset_path("../etc").is_none());
        assert_eq!(
            sniff_image_mime(b"<?xml version=\"1.0\"?>\n<svg xmlns=\"x\"/>"),
            Some("image/svg+xml")
        );
    }
}
