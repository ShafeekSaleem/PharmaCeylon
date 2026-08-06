"use client";

import { IconAlertTriangle, IconCheckCircle, IconInfo } from "@/components/icons";
import type { PosAlert, PosAlertActionKind } from "../types";
import css from "../pos.module.css";

const SEVERITY_CLASS = {
  danger: css.alertDanger,
  warning: css.alertWarning,
  info: css.alertInfo,
} as const;

type Props = {
  alerts: PosAlert[];
  cartEmpty: boolean;
  onAction?: (kind: PosAlertActionKind) => void;
};

export function PosAlertsPanel({ alerts, cartEmpty, onAction }: Props) {
  return (
    <section className={css.panel}>
      <h2 className={css.panelTitle}>Pharmacy Alerts</h2>
      {alerts.length === 0 ? (
        <div className={css.alertsClear}>
          <IconCheckCircle size={15} />
          {cartEmpty ? "Nothing to check yet." : "All clear — this cart is safe to dispense."}
        </div>
      ) : (
        <ul className={css.alertList}>
          {alerts.map((alert) => (
            <li key={alert.id} className={`${css.alertItem} ${SEVERITY_CLASS[alert.severity]}`}>
              {alert.severity === "info" ? (
                <IconInfo size={14} />
              ) : (
                <IconAlertTriangle size={14} />
              )}
              <span className={css.alertBody}>
                <span className={css.alertTitle}>{alert.title}</span>
                <span className={css.alertDetail}>{alert.detail}</span>
                {alert.actions && alert.actions.length > 0 && onAction && (
                  <span className={css.alertActions}>
                    {alert.actions.map((action) => (
                      <button
                        key={action.kind}
                        type="button"
                        className={css.alertActionBtn}
                        onClick={() => onAction(action.kind)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </span>
                )}
              </span>
              <span className={css.alertCount}>
                {alert.count} item{alert.count === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
