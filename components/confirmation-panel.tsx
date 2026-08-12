"use client";

import { useRef, type KeyboardEvent, type RefObject } from "react";

export type ConfirmationTone = "primary" | "danger";

export type ConfirmationModel = {
  id: string;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: ConfirmationTone;
  testId?: string;
};

type ConfirmationPanelProps = {
  model: ConfirmationModel;
  confirmButtonRef: RefObject<HTMLButtonElement | null>;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmationPanel({
  model,
  confirmButtonRef,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmationPanelProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = `${model.id}-confirmation-title`;
  const descriptionId = `${model.id}-confirmation-description`;
  const confirmClassName = model.tone === "danger"
    ? "feature-button feature-button-danger"
    : "feature-button feature-button-primary";

  return (
    <div
      className="palette-message palette-confirm"
      data-testid={model.testId}
      data-confirmation-id={model.id}
      aria-busy={busy}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Tab") return;
        const focusable = [confirmButtonRef.current, cancelButtonRef.current].filter(
          (button): button is HTMLButtonElement => Boolean(button && !button.disabled),
        );
        if (focusable.length === 0) return;
        const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = (currentIndex + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
        if (currentIndex === -1 || (event.shiftKey && currentIndex === 0) || (!event.shiftKey && currentIndex === focusable.length - 1)) {
          event.preventDefault();
          focusable[nextIndex]?.focus();
        }
      }}
    >
      <span id={titleId}>{model.title}</span>
      <small id={descriptionId}>{model.description}</small>
      <div className="feature-form-actions">
        <button
          ref={confirmButtonRef}
          type="button"
          className={confirmClassName}
          disabled={busy}
          onClick={onConfirm}
        >
          {model.confirmLabel}
        </button>
        <button
          ref={cancelButtonRef}
          type="button"
          className="feature-button"
          disabled={busy}
          onClick={onCancel}
        >
          {model.cancelLabel}
        </button>
      </div>
    </div>
  );
}
