import styles from "./KeyHint.module.css";
import { cx } from "./useAction";

/** How each key is written on a button, as in the mockups. */
const LABELS: Record<string, string> = {
  Enter: "↵",
  Escape: "Esc",
  Esc: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Delete: "Del",
  Digit: "Num",
  " ": "Space",
};

/** "Ctrl+Enter" → "Ctrl ↵", "Escape" → "Esc", "F12" → "F12". */
export function keyLabel(keys: string): string {
  return keys
    .split("+")
    .map((part) => LABELS[part.trim()] ?? part.trim())
    .join(" ");
}

/**
 * The key a button answers to, drawn on the button. Pass the same string the button's
 * `useKeyBinding` uses, so the hint can't say one key while another works.
 */
export function KeyHint({
  keys,
  onPrimary,
  small,
  end,
  spaced,
  wideOnly,
}: {
  keys: string;
  /** On a primary (gradient) button. */
  onPrimary?: boolean;
  small?: boolean;
  end?: boolean;
  /** On a button whose children have no gap between them. */
  spaced?: boolean;
  /** Hidden below 1200px wide, where the button's row has no room for it. */
  wideOnly?: boolean;
}) {
  return (
    <kbd
      className={cx(
        styles.kbd,
        onPrimary && styles.onPrimary,
        small && styles.sm,
        end && styles.end,
        spaced && styles.spaced,
        wideOnly && styles.wideOnly,
      )}
      aria-hidden="true"
    >
      {keyLabel(keys)}
    </kbd>
  );
}
