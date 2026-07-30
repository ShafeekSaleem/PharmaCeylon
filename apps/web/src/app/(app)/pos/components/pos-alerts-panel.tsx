"use client";

import { IconAlertTriangle, IconCheckCircle, IconInfo } from "@/components/icons";
import type { PosAlert } from "../types";
import css from "../pos.module.css";

const SEVERITY_CLASS = {
  danger: css.alertDanger,
  warning: css.alertWarning,
  info: css.alertInfo,
} as const;

type Props = {
  alerts: PosAlert[];
  cartEmpty: boolean;
};

export function PosAlertsPanel({ alerts, cartEmpty }: Props) {
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
