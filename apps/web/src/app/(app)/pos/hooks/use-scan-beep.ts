"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "pharmaceylon.pos.beep";

/**
 * Short confirmation tone on a successful scan — the counter equivalent of a
 * supermarket beep. Synthesised so there is no audio asset to ship, and muted
 * by preference (persisted per workstation).
 */
export function useScanBeep() {
  const [enabled, setEnabled] = useState(true);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    setEnabled(window.localStorage.getItem(STORAGE_KEY) !== "off");
  }, []);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
      return next;
    });
  }, []);

  const beep = useCallback(
    (kind: "ok" | "error" = "ok") => {
      if (!enabled || typeof window === "undefined") return;
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        const ctx = (ctxRef.current ??= new Ctor());
        void ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = kind === "ok" ? 1180 : 320;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.11);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.12);
      } catch {
        // Audio is a nicety; never let it break a sale.
      }
    },
    [enabled],
  );

  useEffect(() => () => void ctxRef.current?.close(), []);

  return { beep, beepEnabled: enabled, toggleBeep: toggle };
}
