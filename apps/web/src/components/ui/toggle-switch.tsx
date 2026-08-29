"use client";

import styles from "./toggle-switch.module.css";

export type ToggleSwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible label — required since the control carries no visible text of its own. */
  label: string;
  className?: string;
};

/** Shared on/off pill switch — markup and styling extracted from the page-local pattern
 *  originally in settings/catalog/categories/categories.module.css + category-tree.tsx. */
export function ToggleSwitch({ checked, onChange, disabled, label, className }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-tooltip={label}
      className={`${styles.switch}${checked ? ` ${styles.switchOn}` : ""}${className ? ` ${className}` : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.switchThumb} />
    </button>
  );
}
