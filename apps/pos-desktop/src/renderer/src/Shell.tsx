import type {
  ApiReachability,
  AppInfo,
  DeviceState,
  Printer,
} from "../../shared/ipc-contract";
import { initials, shortDay, time, timeWithSeconds, useNow } from "./format";
import { Icon, type IconName } from "./Icon";
import styles from "./Shell.module.css";
import ui from "./ui.module.css";
import { cx } from "./useAction";

export type Page = "sell" | "returns" | "work" | "stock" | "counter";

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

/** The app's own title bar. Windows draws the minimise, maximise and close buttons over its right end. */
export function TitleBar({
  state,
  api,
}: {
  state: DeviceState | null;
  api: ApiReachability | null;
}) {
  const now = useNow();
  const enrollment = state?.enrollment;
  const placed =
    enrollment?.status === "active" || enrollment?.status === "revoked";
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
        {placed ? (
          <>
            <b>{enrollment.branchName}</b> · {enrollment.counterLabel}
            {enrollment.status === "revoked" && " · switched off"}
          </>
        ) : (
          "Not set up yet"
        )}
      </div>
      <span className={ui.grow} />
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
  session,
  personOpen,
  onPerson,
  onLock,
}: {
  page: Page;
  onPage: (page: Page) => void;
  workCount: number;
  showWork: boolean;
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
  printer,
  info,
}: {
  state: DeviceState;
  api: ApiReachability | null;
  printer: Printer | null | undefined;
  info: AppInfo | null;
}) {
  const session = state.staffSession;
  const local = atTheComputer(state);
  return (
    <footer className={styles.statusbar}>
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
      {session && (
        <span className={styles.sb}>
          <Icon name="users" />
          Signed in <b>{session.staffName}</b> · since{" "}
          {time(new Date(session.openedAt))}
        </span>
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
