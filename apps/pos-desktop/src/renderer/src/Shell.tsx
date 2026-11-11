import type {
  ApiReachability,
  AppInfo,
  DeviceState,
  JournalSync,
  LocalShift,
  Printer,
} from "../../shared/ipc-contract";
import type { ReactNode } from "react";
import {
  lastSyncLabels,
  showLastSyncPill,
} from "./connection-sync";
import { initials, shortDay, shortName, time, timeWithSeconds, useNow, useSecondNow } from "./format";
import { money } from "./sell-model";
import { Icon, type IconName } from "./Icon";
import styles from "./Shell.module.css";
import ui from "./ui.module.css";
import { cx } from "./useAction";
import { tillDisplayName } from "./this-counter-display";

export type Page = "sell" | "returns" | "work" | "stock" | "cash" | "counter";

const TONES = [
  styles.teal,
  styles.violet,
  styles.blue,
  styles.amber,
  styles.emerald,
  styles.rose,
];

/** A person's initials in a colour that stays theirs. */
export function Avatar({
  id,
  name,
  className,
}: {
  id: string;
  name: string;
  className?: string;
}) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <span
      className={cx(styles.av, TONES[hash % TONES.length], className)}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export const atTheComputer = (state: DeviceState) =>
  state.windowsSession.protocol === "console" &&
  !state.windowsSession.remoteSession;

function serverText(api: ApiReachability | null) {
  if (api === null) return "Checking the server…";
  return api.reachable ? "Server reachable" : "Server not reachable";
}

/** Lockstep title-bar pill and status-bar lead segment when the mockup sync state applies (P2b #103). */
export function LastSyncDisplay({ lastSuccessAt, variant }: { lastSuccessAt: string; variant: "title" | "status" }) {
  const now = useSecondNow(true);
  const { detailAgo, detailClock } = lastSyncLabels(lastSuccessAt, now);
  if (variant === "title") {
    return (
      <div role="status" className={styles.conn}>
        <span className={styles.dot} />
        Online <span className={styles.connDetail}>· {detailAgo}</span>
      </div>
    );
  }
  return (
    <span className={cx(styles.sb, styles.sbOk)}>
      <span className={styles.d} />
      <b>Online</b> · {detailClock}
    </span>
  );
}

function ReachabilityPill({ api }: { api: ApiReachability | null }) {
  return (
    <div
      role="status"
      className={cx(
        styles.conn,
        api === null ? styles.connWait : !api.reachable && styles.connBad,
      )}
    >
      <span className={styles.dot} />
      {serverText(api)}
    </div>
  );
}

function ReachabilityStatus({ api }: { api: ApiReachability | null }) {
  return (
    <span
      className={cx(
        styles.sb,
        api?.reachable && styles.sbOk,
        api && !api.reachable && styles.sbBad,
      )}
    >
      <span className={styles.d} />
      <b>{serverText(api)}</b>
      {api && ` · checked ${timeWithSeconds(new Date(api.checkedAt))}`}
    </span>
  );
}

/** The app's own title bar. Windows draws the minimise, maximise and close buttons over its right end. */
export function TitleBar({
  state,
  api,
  journal = null,
}: {
  state: DeviceState | null;
  api: ApiReachability | null;
  journal?: JournalSync | null;
}) {
  const now = useNow();
  const enrollment = state?.enrollment;
  const placed =
    enrollment?.status === "active" || enrollment?.status === "revoked";
  const syncPill = showLastSyncPill(enrollment?.status, api, journal);
  return (
    <header className={styles.titlebar}>
      <div className={styles.brand}>
        <span className={styles.logo}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9.5 3h5a1 1 0 0 1 1 1v4.5H20a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-4.5V20a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-4.5H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h4.5V4a1 1 0 0 1 1-1z" />
          </svg>
        </span>
        PharmaCeylon <span className={styles.tag}>POS</span>
      </div>
      <span className={styles.sep} />
      <div className={styles.where}>
        <Icon name="map-pin" />
        {enrollment && placed ? (
          <>
            <b>{enrollment.branchName}</b> ·{" "}
            {tillDisplayName(enrollment.counterLabel, enrollment.tillId)}
            {enrollment.status === "revoked" && " · switched off"}
          </>
        ) : (
          "Not set up yet"
        )}
      </div>
      <span className={ui.grow} />
      {syncPill && journal?.lastSuccessAt ? (
        <LastSyncDisplay lastSuccessAt={journal.lastSuccessAt} variant="title" />
      ) : (
        <ReachabilityPill api={api} />
      )}
      <div className={styles.clock}>
        {shortDay(now)} · {time(now)}
      </div>
    </header>
  );
}

function RailItem({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cx(styles.ri, active && styles.active)}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <Icon name={icon} />
      {label}
      {badge ? <span className={styles.badge}>{badge}</span> : null}
    </button>
  );
}

export function Rail({
  page,
  onPage,
  workCount,
  showWork,
  showCash = true,
  session,
  personOpen,
  onPerson,
  onLock,
}: {
  page: Page;
  onPage: (page: Page) => void;
  workCount: number;
  showWork: boolean;
  /** Cash & shift: everyone who sells at the counter. */
  showCash?: boolean;
  session: NonNullable<DeviceState["staffSession"]>;
  personOpen: boolean;
  onPerson: () => void;
  onLock: () => void;
}) {
  return (
    <nav className={styles.rail} aria-label="Pages">
      <RailItem
        icon="shopping-cart"
        label="Sell"
        active={page === "sell"}
        onClick={() => onPage("sell")}
      />
      <RailItem
        icon="rotate-ccw"
        label="Returns"
        active={page === "returns"}
        onClick={() => onPage("returns")}
      />
      <div className={styles.railSep} />
      {showWork && (
        <RailItem
          icon="inbox"
          label="Counter work"
          active={page === "work"}
          badge={workCount}
          onClick={() => onPage("work")}
        />
      )}
      <RailItem
        icon="clipboard-list"
        label="Stock"
        active={page === "stock"}
        onClick={() => onPage("stock")}
      />
      {showCash && (
        <RailItem
          icon="wallet"
          label="Cash & shift"
          active={page === "cash"}
          onClick={() => onPage("cash")}
        />
      )}
      <div className={styles.railBottom}>
        <RailItem
          icon="monitor"
          label="This counter"
          active={page === "counter"}
          onClick={() => onPage("counter")}
        />
        <RailItem icon="lock" label="Lock" onClick={onLock} />
        <button
          type="button"
          className={styles.me}
          onClick={onPerson}
          aria-expanded={personOpen}
          aria-haspopup="dialog"
          title={session.staffName}
          aria-label={`${session.staffName}: PIN and sign out`}
        >
          <Avatar id={session.staffUserId} name={session.staffName} />
          <i />
        </button>
      </div>
    </nav>
  );
}

export function StatusBar({
  state,
  api,
  journal = null,
  printer,
  info,
  shift = null,
}: {
  state: DeviceState;
  api: ApiReachability | null;
  journal?: JournalSync | null;
  printer: Printer | null | undefined;
  info: AppInfo | null;
  /** The shift open on this till (this counter's copy). */
  shift?: LocalShift | null;
}) {
  const session = state.staffSession;
  const local = atTheComputer(state);
  const syncPill = showLastSyncPill(state.enrollment?.status, api, journal);
  return (
    <footer className={styles.statusbar}>
      {syncPill && journal?.lastSuccessAt ? (
        <LastSyncDisplay lastSuccessAt={journal.lastSuccessAt} variant="status" />
      ) : (
        <ReachabilityStatus api={api} />
      )}
      {shift ? (
        <>
          <span className={styles.sb}>
            <Icon name="clock" />
            {/* One run of text, so the bar's flex gap doesn't space out its words. */}
            <span>
              Shift {shift.shiftNumber && <b>{shift.shiftNumber}</b>}
              {shift.shiftNumber && " · "}
              {shortName(shift.staffName)}
              <span className={styles.sbLabel}> · since</span>{" "}
              {time(new Date(shift.openedAt))}
              {shift.status === "closing" && " · closing, not yet synced"}
            </span>
          </span>
          <span className={styles.sb}>
            <Icon name="wallet" />
            <span>
              <span className={styles.sbLabel}>Drawer expected </span>
              <b>Rs {money(shift.expectedCashMinor)}</b>
            </span>
          </span>
        </>
      ) : (
        session && (
          <>
            <span className={styles.sb}>
              <Icon name="users" />
              Signed in <b>{session.staffName}</b> · since{" "}
              {time(new Date(session.openedAt))}
            </span>
            <span className={styles.sb}>
              <Icon name="clock" />
              No shift open
            </span>
          </>
        )
      )}
      {printer !== undefined && (
        <span className={styles.sb}>
          <Icon name="printer" />
          {printer ? printer.displayName : "No printer installed"}
        </span>
      )}
      <span className={ui.grow} />
      <span className={cx(styles.sb, local ? styles.sbOk : styles.sbBad)}>
        <Icon name="monitor" />
        {local ? "At the counter" : "Remote session"}
      </span>
      {info && <span className={styles.sb}>v{info.appVersion}</span>}
    </footer>
  );
}

/**
 * P5 #51 (approved D12): after an outage, new sales wait on this counter while it sends its
 * offline sales to the server and takes fresh stock. It resumes by itself; nothing here can skip
 * it. Finishing also waits for every sale and action sent from here to be confirmed, so the Sell
 * page puts its unconfirmed sales inside the block (`children`), where they can still be confirmed;
 * actions are confirmed in Counter work, which the block doesn't cover.
 */
export function SyncBlock({ sync, children }: { sync: JournalSync; children?: ReactNode }) {
  const waiting = sync.pause?.waiting ?? sync.waiting;
  const sales = sync.pause?.unconfirmed.sales ?? 0;
  const actions = sync.pause?.unconfirmed.actions ?? 0;
  const stuck = sync.refused > 0 || sync.issue?.code === "JOURNAL_MISMATCH";
  return (
    <div className={styles.block} role="status" aria-live="polite">
      <div className={cx(ui.panel, styles.blockCard)}>
        <span className={cx(ui.kind, styles.blockIcon, stuck ? null : styles.syncIcon)}>
          <Icon name={stuck ? "alert-triangle" : "refresh"} />
        </span>
        <h2>{stuck ? "Synchronisation needs attention" : "Synchronising offline sales"}</h2>
        <p>
          {waiting > 0
            ? `${waiting} offline ${waiting === 1 ? "record is" : "records are"} on the way to the server. `
            : sales + actions > 0
              ? "The offline sales are on the server. "
              : "The offline sales are on the server; fresh stock is on its way. "}
          New sales start again as soon as it finishes. The sale on screen is kept.
        </p>
        {sales > 0 && (
          <p>
            {sales === 1
              ? "The sale below was sent but not confirmed: synchronisation finishes once it is."
              : `The ${sales} sales below were sent but not confirmed: synchronisation finishes once they are.`}
          </p>
        )}
        {actions > 0 && (
          <p>
            {actions === 1
              ? "An action sent from here waits in Counter work for the person who sent it to confirm it."
              : `${actions} actions sent from here wait in Counter work for the people who sent them to confirm them.`}
          </p>
        )}
        {sync.issue && <p>{sync.issue.message}</p>}
        {children}
      </div>
    </div>
  );
}

/** Covers a selling page while the server can't be reached. The page stays underneath, cart and all. */
export function ServerBlock({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={styles.block} role="alert">
      <div className={cx(ui.panel, styles.blockCard)}>
        <span className={cx(ui.kind, styles.blockIcon)}>
          <Icon name="wifi-off" />
        </span>
        <h2>The server can&apos;t be reached</h2>
        <p>
          Selling needs the server until this counter can sell offline. Check
          the network cable or Wi-Fi. The counter keeps trying every 15 seconds,
          and the sale on screen is kept.
        </p>
        <button
          type="button"
          className={cx(ui.btn, ui.outline, ui.lg)}
          onClick={onRetry}
        >
          <Icon name="refresh" />
          Try again
        </button>
      </div>
    </div>
  );
}
