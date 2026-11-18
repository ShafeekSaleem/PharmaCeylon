import { useEffect, useRef, useState } from "react";
import type {
  JournalSync,
  OfflineJournalEntry,
  OfflineJournalQueue,
  Printer,
} from "../../shared/ipc-contract";
import { time } from "./format";
import { Icon } from "./Icon";
import {
  entryStatus,
  entryTitle,
  queueHeading,
  type QueuePhase,
  type ReconnectNotice,
  type Tone,
} from "./reconnect-model";
import s from "./ReconnectNotice.module.css";
import { money } from "./sell-model";
import ui from "./ui.module.css";
import { cx } from "./useAction";

/**
 * P4 #50, slice 4c: the counter's offline sales after the connection comes back, and the upload
 * queue behind the title bar's count (docs/design/desktop-app/p4-offline-sale-v2: `d-queue`,
 * `d-drain`, `d-review`, `d-stock`, `d-clean`).
 */

const TONE: Record<Tone, string | undefined> = {
  ok: ui.ok,
  info: ui.info,
  warn: ui.warn,
  bad: ui.bad,
  neutral: ui.neutral,
};

function StatusChip({
  entry,
  mode,
}: {
  entry: OfflineJournalEntry;
  mode?: "list" | "last";
}) {
  const status = entryStatus(entry, mode);
  return <span className={cx(ui.pill, TONE[status.tone])}>{status.label}</span>;
}

const at = (iso: string | null) => (iso ? time(new Date(iso)) : "");

/** The title bar's "4 to send" count, which opens the queue. */
export function QueueChip({
  phase,
  label,
  journal,
  queue,
}: {
  phase: QueuePhase;
  label: string;
  journal: JournalSync | null;
  queue: OfflineJournalQueue | null;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className={s.chipWrap} ref={wrap}>
      <button
        type="button"
        className={cx(ui.pill, ui.neutral, s.chip)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="upload" />
        {label}
      </button>
      {open && <QueuePopover phase={phase} journal={journal} queue={queue} />}
    </div>
  );
}

export function QueuePopover({
  phase,
  journal,
  queue,
}: {
  phase: QueuePhase;
  journal: JournalSync | null;
  queue: OfflineJournalQueue | null;
}) {
  const heading = queueHeading(phase, journal, queue);
  const entries = queue?.entries ?? [];
  return (
    <div className={s.popover} role="dialog" aria-label={heading.title}>
      <div className={s.popHead}>
        <h2>{heading.title}</h2>
        <p>{heading.text}</p>
      </div>
      {entries.length > 0 ? (
        <ol className={s.list}>
          {entries.map((entry) => (
            <li key={entry.commandId} className={s.row}>
              <span className={s.when}>{at(entry.at)}</span>
              <span className={s.what}>
                <b>{entryTitle(entry)}</b>
                <span className={ui.mono}>{entry.receiptNumber ?? "–"}</span>
              </span>
              <span className={s.amount}>
                {entry.totalMinor === null
                  ? "—"
                  : `Rs ${money(entry.totalMinor)}`}
              </span>
              <StatusChip entry={entry} />
            </li>
          ))}
        </ol>
      ) : (
        <p className={s.popEmpty}>Reading this counter&apos;s saved records…</p>
      )}
      {queue?.more && (
        <p className={s.popMore}>Older records are on This counter.</p>
      )}
      <p className={s.popFoot}>{heading.footer}</p>
    </div>
  );
}

/** The last offline sale: its final receipt number, where it stands, and a reprint. */
export function LastOfflineSale({
  entry,
  printer,
  title = "Last offline sale",
  floating = false,
  inline = false,
}: {
  entry: OfflineJournalEntry;
  printer: Printer | null | undefined;
  title?: string;
  /** Pinned to the window's corner, over the sign-in screen. */
  floating?: boolean;
  /** One row, inside a banner. */
  inline?: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function reprint() {
    if (!printer) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.pos.printOfflineReceipt({
        saleCommandId: entry.commandId,
        printerName: printer.name,
      });
      setMessage(
        result.ok
          ? "Receipt sent to the printer."
          : (result.error ?? "The receipt did not print."),
      );
    } catch {
      setMessage("The receipt did not print.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={cx(s.last, floating && s.floating, inline && s.inline)}
      aria-label={title}
    >
      <span className={s.lastLabel}>{title}</span>
      <span className={cx(ui.mono, s.lastNumber)}>{entry.receiptNumber}</span>
      <span className={s.lastMeta}>
        {entry.totalMinor !== null && `Rs ${money(entry.totalMinor)}`}
        {entry.at && ` · ${at(entry.at)}`}
      </span>
      <span className={s.lastActions}>
        <StatusChip entry={entry} mode="last" />
        {entry.printable && (
          <button
            type="button"
            className={cx(ui.btn, ui.outline, ui.sm)}
            onClick={() => void reprint()}
            disabled={!printer || busy}
            title={printer ? undefined : "No printer installed"}
          >
            <Icon name="printer" />
            Reprint
          </button>
        )}
      </span>
      {message && (
        <span role="status" className={s.lastMessage}>
          {message}
        </span>
      )}
    </div>
  );
}

const NOTE_TONE: Record<Tone, string | undefined> = {
  ok: s.bannerOk,
  info: undefined,
  warn: ui.noteWarn,
  bad: ui.noteBad,
  neutral: undefined,
};

/** The banner over Sell once the connection is back (`d-drain`, `d-review`, `d-stock`, `d-clean`). */
export function ReconnectBanner({
  notice,
  lastSale,
  printer,
  onDismiss,
}: {
  notice: ReconnectNotice;
  lastSale: OfflineJournalEntry | null;
  printer: Printer | null | undefined;
  onDismiss?: () => void;
}) {
  const icon =
    notice.tone === "ok"
      ? "check-circle"
      : notice.tone === "warn" || notice.tone === "bad"
        ? "alert-triangle"
        : "info";
  return (
    <div
      className={cx(ui.note, NOTE_TONE[notice.tone], s.banner)}
      role="status"
      aria-label={notice.title}
    >
      <Icon name={icon} />
      <div className={s.bannerText}>
        <b>{notice.title}</b>
        <span>{notice.text}</span>
      </div>
      {lastSale && (
        <LastOfflineSale
          entry={lastSale}
          printer={printer}
          title={lastSale.stockReview ? "Offline sale" : "Last offline sale"}
          inline
        />
      )}
      {notice.dismissible && onDismiss && (
        <button
          type="button"
          className={cx(ui.btn, ui.ghost, ui.sm, s.dismiss)}
          onClick={onDismiss}
          aria-label="Put this message away"
        >
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}
