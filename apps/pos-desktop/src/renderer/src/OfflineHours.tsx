import { useState, type FormEvent } from "react";
import type { OfflineStaff } from "../../shared/ipc-contract";
import { time } from "./format";
import { Icon } from "./Icon";
import { KeyHint } from "./KeyHint";
import { useKeyBinding } from "./keymap";
import styles from "./OfflineCounter.module.css";
import { PIN_OK } from "./SignIn";
import ui from "./ui.module.css";
import { cx, ErrorLine, useAction } from "./useAction";

/**
 * P4 #50, D8: outside routine selling hours the offline counter stops until a prepared manager
 * acknowledges it with their own PIN, a reason and how long. The cashier stays signed in. Main
 * caps the window at 24 hours, the grant's expiry and any mandatory closure.
 */

export const HOURS_CHOICES = [30, 60, 120, 240] as const;

export function HoursBanner({
  staff,
  onAcknowledge,
}: {
  staff: OfflineStaff;
  onAcknowledge: () => void;
}) {
  const hours = staff.hours;
  if (!hours || hours.status === "open") return null;
  if (hours.status === "acknowledged")
    return (
      <div className={cx(ui.note, styles.banner)} role="status">
        <Icon name="clock" />
        <div>
          <b>Selling after hours</b>
          <div>
            Until {time(new Date(hours.until))}, acknowledged by{" "}
            {hours.managerName}.
          </div>
        </div>
      </div>
    );
  if (hours.status === "closed")
    return (
      <div className={cx(ui.note, ui.noteBad, styles.banner)} role="alert">
        <Icon name="clock" />
        <div>
          <b>The branch is closed now</b>
          <div>Offline sales can&apos;t be made until it opens again.</div>
        </div>
      </div>
    );
  const managers = staff.people.filter((p) => p.canAcknowledgeHours);
  return (
    <div
      className={cx(ui.note, ui.noteWarn, styles.banner, styles.bannerRow)}
      role="alert"
    >
      <Icon name="clock" />
      <div className={ui.grow}>
        <b>It&apos;s outside selling hours</b>
        <div>
          {managers.length
            ? "A prepared manager acknowledges it with their own PIN before more sales."
            : "Nobody prepared on this counter can acknowledge it, so sales wait until opening time."}
        </div>
      </div>
      {managers.length > 0 && (
        <button
          type="button"
          className={cx(ui.btn, ui.outline)}
          onClick={onAcknowledge}
        >
          Manager acknowledges…
        </button>
      )}
    </div>
  );
}

export function HoursSheet({
  staff,
  onStaff,
  onClose,
}: {
  staff: OfflineStaff;
  onStaff: (staff: OfflineStaff) => void;
  onClose: () => void;
}) {
  const managers = staff.people.filter((p) => p.canAcknowledgeHours);
  const [manager, setManager] = useState(managers[0]?.staffUserId ?? "");
  const [minutes, setMinutes] = useState<number>(60);
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const { busy, error, run } = useAction();
  const ready =
    Boolean(manager) && PIN_OK.test(pin) && reason.trim().length > 0 && !busy;
  useKeyBinding("Escape", onClose);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    const entered = pin;
    setPin("");
    void run(
      () =>
        window.pos.offlineAcknowledgeHours({
          staffUserId: manager,
          pin: entered,
          minutes,
          reason: reason.trim(),
        }),
      (next) => {
        onStaff(next);
        onClose();
      },
    );
  }

  return (
    <div className={styles.scrim} onClick={onClose}>
      <form
        className={cx(ui.panel, styles.sheet)}
        role="dialog"
        aria-label="Acknowledge selling after hours"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className={ui.eyebrow}>Selling after hours</div>
        <h2>A manager acknowledges it</h2>
        <p className={ui.muted}>
          The cashier stays signed in. It never runs past the offline permission
          or a time the branch must close.
        </p>
        <div className={ui.f}>
          <label htmlFor="hours-manager">Manager</label>
          <div className={ui.select}>
            <select
              id="hours-manager"
              className={ui.in}
              value={manager}
              onChange={(e) => setManager(e.target.value)}
            >
              {managers.map((m) => (
                <option key={m.staffUserId} value={m.staffUserId}>
                  {m.staffName}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" />
          </div>
        </div>
        <div className={ui.f}>
          <span className={ui.label}>For how long</span>
          <div className={ui.seg} role="group" aria-label="For how long">
            {HOURS_CHOICES.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={minutes === m}
                onClick={() => setMinutes(m)}
              >
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </button>
            ))}
          </div>
        </div>
        <div className={ui.f}>
          <label htmlFor="hours-reason">Reason</label>
          <input
            id="hours-reason"
            className={ui.in}
            value={reason}
            maxLength={500}
            placeholder="For example, a queue at closing time"
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className={ui.f}>
          <label htmlFor="hours-pin">Manager&apos;s PIN</label>
          <input
            id="hours-pin"
            className={ui.in}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(e) =>
              setPin(e.target.value.replace(/\D/g, "").slice(0, 8))
            }
          />
        </div>
        <ErrorLine error={error} />
        <div className={ui.dfoot}>
          <button
            type="button"
            className={cx(ui.btn, ui.ghost)}
            onClick={onClose}
          >
            Cancel
            <KeyHint keys="Escape" small />
          </button>
          <span className={ui.grow} />
          <button
            type="submit"
            className={cx(ui.btn, ui.primary)}
            disabled={!ready}
          >
            Acknowledge
          </button>
        </div>
      </form>
    </div>
  );
}
