import { useState } from "react";
import type { ActionResult } from "../../shared/ipc-contract";
import ui from "./ui.module.css";

/** Runs one bridge action at a time and keeps its refusal message for the screen. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(
    action: () => Promise<ActionResult<T>>,
    onOk: (value: T) => void,
  ) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.ok) onOk(result.value);
      else setError(result.error.message);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, clear: () => setError(null) };
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className={ui.badText}>
      {error}
    </p>
  ) : null;
}

export const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(" ");
