"use client";

import { BorderBeam } from "border-beam";
import { LayoutGroup, motion, type Transition } from "motion/react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  CODE_LANGUAGES,
  filterCommands,
  filterThemes,
  KEYBOARD_SHORTCUTS,
  PALETTE_ID,
  paletteLabel,
  paletteRole,
  rankCommandOptions,
  type Command,
  type PaletteMode,
  type PaletteState,
} from "@/lib/command-palette";
import type { CommandContext } from "@/lib/command-availability";
import { StatsPanel, ShortcutsPanel, LinkEditorPanel } from "@/components/editor-feature-panels";
import { calculateDocumentStats, type DocumentStats } from "@/lib/document-stats";
import type { DocumentSession } from "@/lib/document-sessions";
import type { LocalSearchResult } from "@/lib/local-search";
import { searchMatchRanges } from "@/lib/local-search";
import type { Backlink } from "@/lib/note-links";
import type { VersionHistoryEntry } from "@/lib/version-history";
import { THEMES, type ThemeId } from "@/lib/theme";
import type { StorageHealth } from "@/lib/local-vault";
import { formatStorageEstimate } from "@/lib/storage-estimate";
import { filterPickerOptions } from "@/lib/picker-filter";

export type LinkEditorState = {
  from: number;
  to: number;
  label: string;
  href: string;
};

const SLASH_PALETTE_INITIAL = {
  opacity: 0,
  transform: "translateY(0px) scale(0.93)",
};
const SLASH_PALETTE_TRANSITION: Transition = {
  type: "spring",
  stiffness: 560,
  damping: 34,
  mass: 0.62,
};
const SLASH_SELECTION_TRANSITION: Transition = {
  type: "spring",
  stiffness: 480,
  damping: 35,
  mass: 0.58,
};

type PaletteSessionMode = Extract<PaletteMode, "sessions" | "archives" | "link-session">;

export type CommandPaletteProps = {
  palette: PaletteState | null;
  paletteElementRef: RefObject<HTMLDivElement | null>;
  selected: number;
  commandContext: CommandContext;
  sessionPinned: boolean;
  sessionArchived: boolean;
  activeTheme: ThemeId;
  prefersReducedMotion: boolean;
  sessions: DocumentSession[];
  documentId: string;
  searchResults: LocalSearchResult[];
  searchLoading: boolean;
  stats: DocumentStats;
  backlinks: Backlink[];
  backlinksLoading: boolean;
  versions: VersionHistoryEntry[];
  health: StorageHealth;
  sessionName: string;
  linkEditorState: LinkEditorState | null;
  pendingMarkdownImport: { fileName: string } | null;
  importConfirming: boolean;
  setPalette: (value: PaletteState | null) => void;
  setSelected: (value: number) => void;
  setSessionName: (value: string) => void;
  updateSearchQuery: (query: string) => void;
  submitSessionName: () => void;
  runCommand: (command: Command) => void;
  openSearchResult: (result: LocalSearchResult) => void;
  onSessionSelect: (session: DocumentSession, mode: PaletteSessionMode) => void;
  chooseCodeLanguage: (language: string) => void;
  chooseTheme: (theme: ThemeId) => void;
  openBacklink: (backlink: Backlink) => void;
  restoreHistoryVersion: (version: VersionHistoryEntry) => void;
  onLinkLabelChange: (label: string) => void;
  onLinkHrefChange: (href: string) => void;
  saveEditedLink: () => void;
  removeEditedLink: () => void;
  cancelLinkEditor: () => void;
  confirmMarkdownImport: () => Promise<void>;
  cancelMarkdownImport: () => void;
  onSearchCompositionStart: () => void;
  onSearchCompositionEnd: () => void;
  onThemeCompositionStart: () => void;
  onThemeCompositionEnd: () => void;
};

function highlightSearchText(value: string, query: string): ReactNode {
  const ranges = searchMatchRanges(value, query);
  if (ranges.length === 0) return value;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(<span key={`text-${index}`}>{value.slice(cursor, range.start)}</span>);
    parts.push(<mark key={`match-${index}`}>{value.slice(range.start, range.end)}</mark>);
    cursor = Math.max(cursor, range.end);
  });
  if (cursor < value.length) parts.push(<span key="text-tail">{value.slice(cursor)}</span>);
  return parts;
}

export function CommandPalette({
  palette,
  paletteElementRef,
  selected,
  commandContext,
  sessionPinned,
  sessionArchived,
  activeTheme,
  prefersReducedMotion,
  sessions,
  documentId,
  searchResults,
  searchLoading,
  stats,
  backlinks,
  backlinksLoading,
  versions,
  health,
  sessionName,
  linkEditorState,
  pendingMarkdownImport,
  importConfirming,
  setPalette,
  setSelected,
  setSessionName,
  updateSearchQuery,
  submitSessionName,
  runCommand,
  openSearchResult,
  onSessionSelect,
  chooseCodeLanguage,
  chooseTheme,
  openBacklink,
  restoreHistoryVersion,
  onLinkLabelChange,
  onLinkHrefChange,
  saveEditedLink,
  removeEditedLink,
  cancelLinkEditor,
  confirmMarkdownImport,
  cancelMarkdownImport,
  onSearchCompositionStart,
  onSearchCompositionEnd,
  onThemeCompositionStart,
  onThemeCompositionEnd,
}: CommandPaletteProps) {
  const sessionNameInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const themeSearchInputRef = useRef<HTMLInputElement>(null);
  const importConfirmButtonRef = useRef<HTMLButtonElement>(null);
  const pickerFilterInputRef = useRef<HTMLInputElement>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const searchResultRefs = useRef(new Map<string, HTMLDivElement>());
  const rankedCommands = rankCommandOptions(palette, sessionPinned, sessionArchived, commandContext);
  const filtered = filterCommands(palette, sessionPinned, sessionArchived, commandContext);
  const filteredThemes = filterThemes(palette);
  const formattedStorageEstimate = formatStorageEstimate(health.storageEstimate);
  const filteredSessions = filterPickerOptions(sessions, pickerQuery, (session) => session.name);
  const filteredBacklinks = filterPickerOptions(backlinks, pickerQuery, (backlink) => `${backlink.name} ${backlink.excerpt}`);
  const filteredVersions = filterPickerOptions(versions, pickerQuery, (version) => version.markdown);

  useEffect(() => {
    if (!["sessions", "archives", "link-session", "backlinks", "history"].includes(palette?.mode ?? "")) return;
    const frame = window.requestAnimationFrame(() => {
      setPickerQuery("");
      setSelected(0);
      pickerFilterInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [palette?.mode, setSelected]);

  const pickerInput = (label: string, options: readonly unknown[], select: (index: number) => void) => (
    <div className="search-field picker-filter-field">
      <input
        ref={pickerFilterInputRef}
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={PALETTE_ID}
        aria-label={label}
        value={pickerQuery}
        onChange={(event) => { setPickerQuery(event.target.value); setSelected(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); event.stopPropagation();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setSelected((selected + direction + Math.max(1, options.length)) % Math.max(1, options.length));
          } else if (event.key === "Enter" && options.length > 0) {
            event.preventDefault(); event.stopPropagation(); select(selected);
          }
        }}
      />
    </div>
  );

  useEffect(() => {
    if (palette?.mode !== "name" && palette?.mode !== "search" && palette?.mode !== "theme") return;
    const frame = window.requestAnimationFrame(() => {
      const input = palette.mode === "name"
        ? sessionNameInputRef.current
        : palette.mode === "search"
          ? searchInputRef.current
          : themeSearchInputRef.current;
      input?.focus();
      input?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [palette?.mode]);

  useEffect(() => {
    if (palette?.mode !== "confirm-import" || importConfirming) return;
    const frame = window.requestAnimationFrame(() => {
      importConfirmButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [importConfirming, palette?.mode]);

  useEffect(() => {
    if (palette?.mode !== "theme") return;
    const activeThemeOption = filteredThemes[selected];
    if (!activeThemeOption) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`${PALETTE_ID}-theme-${activeThemeOption.id}`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filteredThemes, palette?.mode, selected]);

  useEffect(() => {
    if (palette?.mode !== "search" || searchLoading) return;
    const activeResult = searchResults[selected];
    if (!activeResult) return;
    const frame = window.requestAnimationFrame(() => {
      searchResultRefs.current
        .get(activeResult.documentId)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [palette?.mode, searchLoading, searchResults, selected]);

  useEffect(() => {
    if (palette?.mode === "search") return;
    searchResultRefs.current.clear();
  }, [palette?.mode]);

  if (!palette) return null;

  return (
    <div
      ref={paletteElementRef}
      className="command-palette-positioner"
      style={{ left: Math.round(palette.left), top: Math.round(palette.top) }}
    >
      <motion.div
        className="command-palette-motion"
        initial={prefersReducedMotion ? { opacity: 0, transform: "none" } : SLASH_PALETTE_INITIAL}
        animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
        transition={prefersReducedMotion ? { duration: 0.08, ease: [0.23, 1, 0.32, 1] } : SLASH_PALETTE_TRANSITION}
      >
        <BorderBeam
          className="command-palette-frame"
          size="line"
          colorVariant="mono"
          theme={THEMES.find((theme) => theme.id === activeTheme)?.colorScheme ?? "dark"}
          staticColors
          duration={3.2}
          active={(palette.mode === "commands" || palette.mode === "search") && !prefersReducedMotion}
          strength={0.42}
          brightness={1.05}
          saturation={0}
          borderRadius={13}
        >
          <div
            id={PALETTE_ID}
            className="command-palette"
            role={paletteRole(palette.mode)}
            aria-label={paletteLabel(palette.mode)}
          >
            {palette.mode === "commands" ? (
              rankedCommands.length > 0 ? (
                <LayoutGroup id="slash-command-selection">
                  <div className="command-list">
                    {rankedCommands.map(({ command, availability }) => {
                      const selectableIndex = availability.available
                        ? filtered.findIndex((candidate) => candidate.id === command.id)
                        : -1;
                      const isSelected = selectableIndex >= 0 && selectableIndex === selected;
                      const reasonId = `${PALETTE_ID}-${command.id}-reason`;
                      return <div
                        className="command-item"
                        data-motion-selection={isSelected}
                        data-selected={isSelected}
                        data-disabled={!availability.available}
                        id={`${PALETTE_ID}-${command.id}`}
                        key={command.id}
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={!availability.available}
                        aria-describedby={availability.reason ? reasonId : undefined}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          if (availability.available) runCommand(command);
                        }}
                        onMouseEnter={() => {
                          if (selectableIndex >= 0) setSelected(selectableIndex);
                        }}
                      >
                        {isSelected ? (
                          <motion.div
                            className="command-selection-motion"
                            layoutId="slash-command-selection"
                            transition={prefersReducedMotion ? { duration: 0 } : SLASH_SELECTION_TRANSITION}
                            aria-hidden="true"
                          />
                        ) : null}
                        <span>{command.label}</span>
                        <small id={reasonId}>{availability.reason ?? command.detail}</small>
                      </div>
                    })}
                  </div>
                </LayoutGroup>
              ) : (
                <div className="palette-message">No command</div>
              )
            ) : palette.mode === "search" ? (
              <div className="search-panel" data-testid="search-panel">
                <div className="search-field">
                  <span className="search-field-prefix" aria-hidden="true">/</span>
                  <input
                    ref={searchInputRef}
                    type="search"
                    role="combobox"
                    aria-label="Search local notes"
                    aria-expanded="true"
                    aria-controls={`${PALETTE_ID}-results`}
                    aria-activedescendant={!searchLoading && searchResults[selected]
                      ? `${PALETTE_ID}-search-${searchResults[selected].documentId}`
                      : undefined}
                    aria-autocomplete="list"
                    aria-haspopup="listbox"
                    autoComplete="off"
                    placeholder="Search sessions and note text"
                    value={palette.query}
                    onChange={(event) => updateSearchQuery(event.target.value)}
                    onCompositionStart={onSearchCompositionStart}
                    onCompositionEnd={onSearchCompositionEnd}
                  />
                  <kbd>Esc</kbd>
                </div>
                <div className="search-summary" role="status" aria-live="polite">
                  {searchLoading
                    ? "Indexing local notes…"
                    : palette.query.trim()
                      ? `${searchResults.length} ${searchResults.length === 1 ? "match" : "matches"}`
                      : `${sessions.length} local ${sessions.length === 1 ? "session" : "sessions"}`}
                </div>
                <div id={`${PALETTE_ID}-results`} className="search-results" role="listbox" aria-label="Search results">
                  {searchLoading ? (
                    <div className="search-empty">Reading verified local copies…</div>
                  ) : palette.query.trim() && searchResults.length > 0 ? (
                    searchResults.map((result, index) => (
                      <div
                        ref={(element) => {
                          if (element) searchResultRefs.current.set(result.documentId, element);
                          else searchResultRefs.current.delete(result.documentId);
                        }}
                        className="search-result"
                        data-testid="search-result"
                        data-selected={index === selected}
                        data-current={result.documentId === documentId}
                        id={`${PALETTE_ID}-search-${result.documentId}`}
                        key={result.documentId}
                        role="option"
                        aria-selected={index === selected}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          openSearchResult(result);
                        }}
                        onMouseEnter={() => setSelected(index)}
                      >
                        <div className="search-result-heading">
                          <span>{highlightSearchText(result.name, palette.query)}</span>
                          <small>
                            {result.documentId === documentId ? "Current session · " : ""}
                            {result.match === "name"
                              ? "Session name"
                              : result.match === "content"
                                ? "Note text"
                                : "Name + note text"}
                          </small>
                        </div>
                        <div className="search-result-excerpt">
                          {highlightSearchText(result.excerpt || "Session name match", palette.query)}
                        </div>
                      </div>
                    ))
                  ) : palette.query.trim() ? (
                    <div className="search-empty">No local notes match “{palette.query.trim()}”.</div>
                  ) : (
                    <div className="search-empty">Search session names and the text of every local note.</div>
                  )}
                </div>
                <div className="search-footer">↑↓ move · Enter open · Esc close · local only</div>
              </div>
            ) : palette.mode === "name" ? (
              <div className="session-name-panel">
                <label htmlFor="session-name-input">Session name</label>
                <input
                  ref={sessionNameInputRef}
                  id="session-name-input"
                  value={sessionName}
                  maxLength={80}
                  autoComplete="off"
                  onChange={(event) => setSessionName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitSessionName();
                    }
                  }}
                />
                <small>Enter to save · Esc to cancel</small>
              </div>
            ) : palette.mode === "sessions" || palette.mode === "archives" || palette.mode === "link-session" ? (
              <div className="command-list session-list" data-testid="session-list">
                {pickerInput(
                  palette.mode === "archives" ? "Search archived sessions" : palette.mode === "link-session" ? "Search sessions to link" : "Search sessions",
                  filteredSessions,
                  (index) => filteredSessions[index] && onSessionSelect(filteredSessions[index], palette.mode as PaletteSessionMode),
                )}
                {filteredSessions.length > 0 ? filteredSessions.map((session, index) => (
                  <div
                    className="command-item"
                    data-selected={index === selected}
                    data-current={session.id === documentId}
                    id={`${PALETTE_ID}-session-${session.id}`}
                    key={session.id}
                    role="option"
                    aria-selected={index === selected}
                    aria-current={session.id === documentId ? "true" : undefined}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onSessionSelect(session, palette.mode as PaletteSessionMode);
                    }}
                    onMouseEnter={() => setSelected(index)}
                  >
                    <span>{session.pinned ? "◆ " : ""}{session.name}</span>
                    <small>
                      {palette.mode === "link-session"
                        ? session.archived ? "Archived · insert local link" : "Insert local link"
                        : session.id === documentId
                          ? "Current session"
                          : session.updatedAt > 0 ? new Date(session.updatedAt).toLocaleString() : "Original session"}
                    </small>
                  </div>
                )) : (
                  <div className="palette-message">
                    <span>{pickerQuery ? "No sessions match" : palette.mode === "archives" ? "No archived sessions" : palette.mode === "link-session" ? "No other sessions to link" : "No sessions"}</span>
                    <small>Esc to return to the editor</small>
                  </div>
                )}
              </div>
            ) : palette.mode === "stats" ? (
              <StatsPanel stats={stats} />
            ) : palette.mode === "shortcuts" ? (
              <ShortcutsPanel shortcuts={KEYBOARD_SHORTCUTS} />
            ) : palette.mode === "language" ? (
              <div className="command-list language-list" data-testid="language-list">
                {CODE_LANGUAGES.map((language, index) => (
                  <div
                    className="command-item"
                    data-selected={index === selected}
                    id={`${PALETTE_ID}-language-${language.id || "plain"}`}
                    key={language.id || "plain"}
                    role="option"
                    aria-selected={index === selected}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      chooseCodeLanguage(language.id);
                    }}
                    onMouseEnter={() => setSelected(index)}
                  >
                    <span>{language.label}</span>
                    <small>{language.id ? `\`\`\`${language.id}` : "No fence identifier"}</small>
                  </div>
                ))}
              </div>
            ) : palette.mode === "theme" ? (
              <div className="theme-panel" data-testid="theme-panel">
                <div className="search-field">
                  <span className="search-field-prefix" aria-hidden="true">◐</span>
                  <input
                    ref={themeSearchInputRef}
                    type="search"
                    role="combobox"
                    aria-label="Search themes"
                    aria-expanded="true"
                    aria-controls={`${PALETTE_ID}-theme-results`}
                    aria-activedescendant={filteredThemes[selected]
                      ? `${PALETTE_ID}-theme-${filteredThemes[selected].id}`
                      : undefined}
                    aria-autocomplete="list"
                    aria-haspopup="listbox"
                    autoComplete="off"
                    placeholder="Search themes"
                    value={palette.query}
                    onCompositionStart={onThemeCompositionStart}
                    onCompositionEnd={onThemeCompositionEnd}
                    onChange={(event) => {
                      setSelected(0);
                      setPalette({ ...palette, query: event.target.value });
                    }}
                  />
                  <kbd>Esc</kbd>
                </div>
                <div
                  id={`${PALETTE_ID}-theme-results`}
                  className="command-list theme-list"
                  data-testid="theme-list"
                  role="listbox"
                  aria-label="Theme results"
                  tabIndex={-1}
                >
                  {filteredThemes.length > 0 ? filteredThemes.map((theme, index) => (
                    <div
                      className="command-item theme-item"
                      data-selected={index === selected}
                      data-current={theme.id === activeTheme}
                      id={`${PALETTE_ID}-theme-${theme.id}`}
                      key={theme.id}
                      role="option"
                      aria-selected={index === selected}
                      aria-current={theme.id === activeTheme ? "true" : undefined}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        chooseTheme(theme.id);
                      }}
                      onMouseEnter={() => setSelected(index)}
                    >
                      <span className="theme-label">
                        <span className="theme-swatches" aria-hidden="true">
                          {theme.swatches.map((color) => (
                            <span key={color} style={{ backgroundColor: color }} />
                          ))}
                        </span>
                        {theme.label}
                      </span>
                      <small>{theme.id === activeTheme ? "Current" : theme.detail}</small>
                    </div>
                  )) : (
                    <div className="search-empty">No themes match “{palette.query.trim()}”.</div>
                  )}
                </div>
                <div className="search-footer theme-footer">
                  <span>{filteredThemes.length} {filteredThemes.length === 1 ? "theme" : "themes"} · ↑↓ move · Enter select</span>
                  <a href="./third-party-notices/" target="_blank" rel="noreferrer">Licenses</a>
                </div>
              </div>
            ) : palette.mode === "backlinks" ? (
              <div className="feature-list-panel" data-testid="backlinks-panel">
                <div className="feature-list-header">
                  <span>Backlinks</span>
                  <small>{backlinksLoading ? "Reading local notes…" : `${backlinks.length} incoming ${backlinks.length === 1 ? "link" : "links"}`}</small>
                </div>
                {pickerInput("Search backlinks", filteredBacklinks, (index) => filteredBacklinks[index] && openBacklink(filteredBacklinks[index]))}
                <div className="command-list feature-result-list">
                  {backlinksLoading ? (
                    <div className="palette-message"><span>Finding links…</span><small>Verified local copies only</small></div>
                  ) : filteredBacklinks.length > 0 ? filteredBacklinks.map((backlink, index) => (
                    <div
                      className="command-item feature-result-item"
                      data-selected={index === selected}
                      id={`${PALETTE_ID}-backlink-${backlink.documentId}`}
                      key={backlink.documentId}
                      role="option"
                      aria-selected={index === selected}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        openBacklink(backlink);
                      }}
                      onMouseEnter={() => setSelected(index)}
                    >
                      <span>{backlink.name}</span>
                      <small>{backlink.excerpt}</small>
                    </div>
                  )) : (
                    <div className="palette-message"><span>No backlinks yet</span><small>Use /link-note in another session to create one</small></div>
                  )}
                </div>
              </div>
            ) : palette.mode === "history" ? (
              <div className="feature-list-panel" data-testid="version-history-panel">
                <div className="feature-list-header">
                  <span>Version history</span>
                  <small>{versions.length} local {versions.length === 1 ? "version" : "versions"}</small>
                </div>
                {pickerInput("Search version history", filteredVersions, (index) => filteredVersions[index] && restoreHistoryVersion(filteredVersions[index]))}
                <div className="command-list feature-result-list">
                  {filteredVersions.length > 0 ? filteredVersions.map((version, index) => {
                    const versionStats = calculateDocumentStats(version.markdown);
                    return (
                      <div
                        className="command-item feature-result-item"
                        data-selected={index === selected}
                        id={`${PALETTE_ID}-version-${version.id}`}
                        key={version.id}
                        role="option"
                        aria-selected={index === selected}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          restoreHistoryVersion(version);
                        }}
                        onMouseEnter={() => setSelected(index)}
                      >
                        <span>{new Date(version.createdAt).toLocaleString()}</span>
                        <small>{versionStats.words} {versionStats.words === 1 ? "word" : "words"} · Enter to restore</small>
                      </div>
                    );
                  }) : (
                    <div className="palette-message"><span>No saved versions yet</span><small>Versions appear after durable local saves</small></div>
                  )}
                </div>
              </div>
            ) : palette.mode === "link-editor" && linkEditorState ? (
              <LinkEditorPanel
                label={linkEditorState.label}
                href={linkEditorState.href}
                onLabelChange={onLinkLabelChange}
                onHrefChange={onLinkHrefChange}
                onSave={saveEditedLink}
                onRemove={removeEditedLink}
                onCancel={cancelLinkEditor}
                saveDisabled={!linkEditorState.label.trim() || !linkEditorState.href.trim()}
              />
            ) : palette.mode === "confirm-import" ? (
              <div className="palette-message palette-confirm" data-testid="confirm-import">
                <span>Replace this note with “{pendingMarkdownImport?.fileName || "the selected Markdown file"}”?</span>
                <small>The current note will be kept in version history.</small>
                <div className="feature-form-actions">
                  <button
                    ref={importConfirmButtonRef}
                    type="button"
                    className="feature-button feature-button-primary"
                    disabled={importConfirming}
                    onClick={() => { void confirmMarkdownImport(); }}
                  >
                    Import file
                  </button>
                  <button
                    type="button"
                    className="feature-button"
                    disabled={importConfirming}
                    onClick={() => cancelMarkdownImport()}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : palette.mode === "confirm-clear" ? (
              <div className="palette-message palette-confirm">
                <span>Clear the note?</span>
                <small>Press Enter to confirm · Esc to keep it</small>
              </div>
            ) : palette.mode === "confirm-delete" ? (
              <div className="palette-message palette-confirm" data-testid="confirm-delete">
                <span>Delete this session permanently?</span>
                <small>Press Enter to confirm · Esc to keep it</small>
              </div>
            ) : (
              <div className="palette-message storage-message" data-testid="storage-status">
                <span>{health.copies} local {health.copies === 1 ? "copy" : "copies"}</span>
                <small>{health.labels.join(" · ") || "Storage is unavailable"}</small>
                {health.conflicts > 0 ? <small>{health.conflicts} recoverable {health.conflicts === 1 ? "draft" : "drafts"} · /recover to export</small> : null}
                {formattedStorageEstimate ? <small>Approximate browser storage: {formattedStorageEstimate}</small> : null}
                <small>{health.persistent ? "Persistent storage granted" : "Browser-managed persistence"} · no network access</small>
              </div>
            )}
          </div>
        </BorderBeam>
      </motion.div>
    </div>
  );
}
