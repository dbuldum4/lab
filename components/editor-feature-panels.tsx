"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { DocumentStats } from "@/lib/document-stats";

export type StatsPanelProps = {
  stats: DocumentStats;
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function StatsPanel({ stats }: StatsPanelProps) {
  const titleId = useId();
  const items = [
    { label: "Words", value: NUMBER_FORMAT.format(stats.words) },
    { label: "Characters", value: NUMBER_FORMAT.format(stats.characters) },
    { label: "Without spaces", value: NUMBER_FORMAT.format(stats.charactersNoSpaces) },
    { label: "Paragraphs", value: NUMBER_FORMAT.format(stats.paragraphs) },
    { label: "Headings", value: NUMBER_FORMAT.format(stats.headings) },
    { label: "Code blocks", value: NUMBER_FORMAT.format(stats.codeBlocks) },
    {
      label: "Reading time",
      value: `${NUMBER_FORMAT.format(stats.readingMinutes)} min`,
    },
  ];

  return (
    <section className="feature-panel stats-panel" aria-labelledby={titleId}>
      <header className="feature-panel-header stats-panel-header">
        <div>
          <h2 id={titleId}>Document statistics</h2>
          <p>Counts reflect the readable text in this note.</p>
        </div>
      </header>
      <dl className="stats-panel-grid">
        {items.map((item) => (
          <div className="stats-panel-item" key={item.label}>
            <dt className="stats-panel-label">{item.label}</dt>
            <dd className="stats-panel-value">{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export type ShortcutItem = {
  keys: string;
  action: string;
};

export type ShortcutsPanelProps = {
  shortcuts: readonly ShortcutItem[];
};

export function ShortcutsPanel({ shortcuts }: ShortcutsPanelProps) {
  const titleId = useId();

  return (
    <section className="feature-panel shortcuts-panel" aria-labelledby={titleId}>
      <header className="feature-panel-header shortcuts-panel-header">
        <div>
          <h2 id={titleId}>Keyboard shortcuts</h2>
          <p>Use these commands without leaving the editor.</p>
        </div>
      </header>
      {shortcuts.length > 0 ? (
        <ul className="shortcuts-panel-list">
          {shortcuts.map((shortcut, index) => (
            <li className="shortcuts-panel-item" key={`${shortcut.keys}-${shortcut.action}-${index}`}>
              <span className="shortcuts-panel-action">{shortcut.action}</span>
              <kbd className="shortcuts-panel-keys" aria-label={`Shortcut: ${shortcut.keys}`}>
                {shortcut.keys}
              </kbd>
            </li>
          ))}
        </ul>
      ) : (
        <p className="feature-panel-empty shortcuts-panel-empty">No shortcuts are available.</p>
      )}
    </section>
  );
}

export type LinkEditorPanelProps = {
  label: string;
  href: string;
  onLabelChange: (label: string) => void;
  onHrefChange: (href: string) => void;
  onSave: () => void;
  onRemove: () => void;
  onCancel: () => void;
  labelError?: string | null;
  hrefError?: string | null;
  error?: string | null;
  saveDisabled?: boolean;
};

export function LinkEditorPanel({
  label,
  href,
  onLabelChange,
  onHrefChange,
  onSave,
  onRemove,
  onCancel,
  labelError = null,
  hrefError = null,
  error = null,
  saveDisabled = false,
}: LinkEditorPanelProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const labelId = `${id}-label`;
  const labelHintId = `${id}-label-hint`;
  const labelErrorId = `${id}-label-error`;
  const hrefId = `${id}-href`;
  const hrefHintId = `${id}-href-hint`;
  const hrefErrorId = `${id}-href-error`;
  const errorId = `${id}-error`;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave();
  };

  const cancelOnEscape = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  return (
    <form
      className="feature-panel feature-form link-editor-panel"
      aria-labelledby={titleId}
      noValidate
      onSubmit={submit}
      onKeyDown={cancelOnEscape}
    >
      <header className="feature-panel-header link-editor-panel-header">
        <div>
          <h2 id={titleId}>Edit link</h2>
          <p>Change the text readers see or where the link opens.</p>
        </div>
      </header>

      <div className="feature-form-fields link-editor-panel-fields">
        <div className="feature-form-field link-editor-panel-field">
          <label className="feature-form-label" htmlFor={labelId}>Link text</label>
          <input
            className="feature-form-input link-editor-panel-input"
            id={labelId}
            value={label}
            autoFocus
            autoComplete="off"
            aria-invalid={labelError ? "true" : undefined}
            aria-describedby={`${labelHintId}${labelError ? ` ${labelErrorId}` : ""}`}
            onChange={(event) => onLabelChange(event.target.value)}
          />
          <p className="feature-form-hint" id={labelHintId}>The text shown in the note.</p>
          <p
            className="feature-form-error"
            id={labelErrorId}
            aria-live="polite"
            aria-atomic="true"
            data-visible={labelError ? "true" : "false"}
          >
            {labelError ?? ""}
          </p>
        </div>

        <div className="feature-form-field link-editor-panel-field">
          <label className="feature-form-label" htmlFor={hrefId}>Destination</label>
          <input
            className="feature-form-input link-editor-panel-input"
            id={hrefId}
            value={href}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={hrefError ? "true" : undefined}
            aria-describedby={`${hrefHintId}${hrefError ? ` ${hrefErrorId}` : ""}`}
            onChange={(event) => onHrefChange(event.target.value)}
          />
          <p className="feature-form-hint" id={hrefHintId}>Paste a web address or choose a local note link.</p>
          <p
            className="feature-form-error"
            id={hrefErrorId}
            aria-live="polite"
            aria-atomic="true"
            data-visible={hrefError ? "true" : "false"}
          >
            {hrefError ?? ""}
          </p>
        </div>
      </div>

      <p
        className="feature-form-error feature-form-error-summary"
        id={errorId}
        aria-live="polite"
        aria-atomic="true"
        data-visible={error ? "true" : "false"}
      >
        {error ?? ""}
      </p>

      <div className="feature-form-actions link-editor-panel-actions">
        <button type="button" className="feature-button feature-button-danger" onClick={onRemove}>
          Remove link
        </button>
        <div className="feature-form-actions-primary">
          <button type="button" className="feature-button feature-button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="feature-button feature-button-primary" disabled={saveDisabled}>
            Save link
          </button>
        </div>
      </div>
    </form>
  );
}

export type ImageMetadata = {
  alt: string;
  title: string;
};

export type ImageMetadataDialogProps = {
  target: ImageMetadata;
  onSave: (metadata: ImageMetadata) => void;
  onCancel: () => void;
  error?: string | null;
  saveDisabled?: boolean;
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusWithoutScrolling(element: HTMLElement) {
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && element.getAttribute("aria-hidden") !== "true");
}

function useModalFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  onCancel: () => void,
) {
  const cancelRef = useRef(onCancel);

  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    focusWithoutScrolling(initialFocusRef.current ?? focusableElements(dialog)[0] ?? dialog);

    const keepFocusInside = (event: FocusEvent) => {
      const currentDialog = dialogRef.current;
      if (!currentDialog || currentDialog.contains(event.target as Node)) return;
      focusWithoutScrolling(initialFocusRef.current ?? focusableElements(currentDialog)[0] ?? currentDialog);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelRef.current();
    };

    document.addEventListener("focusin", keepFocusInside);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("focusin", keepFocusInside);
      document.removeEventListener("keydown", closeOnEscape, true);
      if (previousFocus?.isConnected) focusWithoutScrolling(previousFocus);
    };
  }, [dialogRef, initialFocusRef]);
}

function trapTabWithin(event: KeyboardEvent<HTMLElement>, dialog: HTMLElement | null) {
  if (event.key !== "Tab" || !dialog) return;
  const focusable = focusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    focusWithoutScrolling(dialog);
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (
    active === dialog
    || !dialog.contains(active)
    || (event.shiftKey && active === first)
    || (!event.shiftKey && active === last)
  ) {
    event.preventDefault();
    focusWithoutScrolling(event.shiftKey ? last : first);
  }
}

type ImageMetadataDraft = ImageMetadata & {
  sourceAlt: string;
  sourceTitle: string;
};

export function ImageMetadataDialog({
  target,
  onSave,
  onCancel,
  error = null,
  saveDisabled = false,
}: ImageMetadataDialogProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const altId = `${id}-alt`;
  const altHintId = `${id}-alt-hint`;
  const imageTitleId = `${id}-image-title`;
  const imageTitleHintId = `${id}-image-title-hint`;
  const errorId = `${id}-error`;
  const dialogRef = useRef<HTMLElement>(null);
  const altInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ImageMetadataDraft>(() => ({
    alt: target.alt,
    title: target.title,
    sourceAlt: target.alt,
    sourceTitle: target.title,
  }));

  const targetChanged = draft.sourceAlt !== target.alt || draft.sourceTitle !== target.title;
  const alt = targetChanged ? target.alt : draft.alt;
  const imageTitle = targetChanged ? target.title : draft.title;

  useModalFocusTrap(dialogRef, altInputRef, onCancel);

  const updateDraft = (next: Partial<ImageMetadata>) => {
    setDraft({
      alt,
      title: imageTitle,
      sourceAlt: target.alt,
      sourceTitle: target.title,
      ...next,
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave({ alt, title: imageTitle });
  };

  return (
    <div className="image-metadata-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="image-metadata-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ""}`}
        tabIndex={-1}
        onKeyDown={(event) => trapTabWithin(event, dialogRef.current)}
      >
        <header className="image-metadata-dialog-header">
          <div>
            <h2 id={titleId}>Image metadata</h2>
            <p id={descriptionId}>Describe this image for readers and assistive technology.</p>
          </div>
          <button
            type="button"
            className="image-metadata-dialog-close"
            aria-label="Close image metadata"
            onClick={onCancel}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <form className="feature-form image-metadata-form" noValidate onSubmit={submit}>
          <div className="feature-form-fields image-metadata-form-fields">
            <div className="feature-form-field image-metadata-form-field">
              <label className="feature-form-label" htmlFor={altId}>Alternative text</label>
              <input
                ref={altInputRef}
                className="feature-form-input image-metadata-form-input"
                id={altId}
                value={alt}
                aria-describedby={altHintId}
                onChange={(event) => updateDraft({ alt: event.target.value })}
              />
              <p className="feature-form-hint" id={altHintId}>
                Describe the image’s purpose. Leave blank only when it is decorative.
              </p>
            </div>

            <div className="feature-form-field image-metadata-form-field">
              <label className="feature-form-label" htmlFor={imageTitleId}>Title</label>
              <input
                className="feature-form-input image-metadata-form-input"
                id={imageTitleId}
                value={imageTitle}
                aria-describedby={imageTitleHintId}
                onChange={(event) => updateDraft({ title: event.target.value })}
              />
              <p className="feature-form-hint" id={imageTitleHintId}>Optional text shown as an image tooltip.</p>
            </div>
          </div>

          <p
            className="feature-form-error feature-form-error-summary"
            id={errorId}
            aria-live="polite"
            aria-atomic="true"
            data-visible={error ? "true" : "false"}
          >
            {error ?? ""}
          </p>

          <div className="feature-form-actions image-metadata-form-actions">
            <button type="button" className="feature-button feature-button-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="feature-button feature-button-primary" disabled={saveDisabled}>
              Save metadata
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
