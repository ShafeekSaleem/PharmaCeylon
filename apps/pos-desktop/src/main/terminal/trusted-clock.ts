import { uptime } from "node:os";
import type { PosDatabase } from "../db/database";

/**
 * P4 #50: trusted time for offline decisions (POS_V1_CONTRACT, "Trusted time"): the latest
 * server-signed time this computer received, plus Windows uptime elapsed since. The Windows clock
 * alone is never trusted: anyone at the counter can move it.
 *
 * Anchors come only from times the server signs and this computer has verified: a freshly
 * installed offline-authority snapshot's `generatedAt` and a verified journal sync reply's
 * `serverTime`. The anchor is taken when the signed time arrives, so trusted time runs slightly
 * behind the server's by the request's latency, never ahead of it.
 *
 * Uptime restarts with Windows. Decision of 2026-11-17: after a reboot or a power cut there is no
 * trusted time until the counter is online again (`NEW_BOOT`), so an outage cannot continue
 * offline across one; an app restart in the same Windows session keeps the anchor.
 *
 * The Windows clock is used for one cross-check only: Windows clock minus uptime is when this boot
 * started, and that stays put while nothing moves the clock. If it has moved by more than
 * `BOOT_DRIFT_TOLERANCE_MS` since the anchor, the boot is not provably the same one (a restart
 * long enough ago that uptime has grown past the anchor's, a clock changed by hand, or a sleep
 * that uptime did not count), so time is untrusted until the next anchor: fail closed.
 */

/** Clock corrections Windows makes by itself stay well inside this. */
export const BOOT_DRIFT_TOLERANCE_MS = 2 * 60_000;

export type TrustedClockSource = "snapshot" | "sync_response";

export type ClockUntrustedReason =
  /** No signed server time has been received on this computer yet. */
  | "NO_ANCHOR"
  /** Windows restarted (or may have) since the last signed server time. */
  | "NEW_BOOT";

export type TrustedNow =
  | {
      trusted: true;
      nowMs: number;
      anchoredAt: number;
      source: TrustedClockSource;
    }
  | { trusted: false; reason: ClockUntrustedReason };

type AnchorRow = {
  server_time_ms: number;
  uptime_ms: number;
  boot_wall_ms: number;
  source: TrustedClockSource;
  high_water_ms: number;
};

export type TrustedClockDeps = {
  db: PosDatabase;
  /** Milliseconds since Windows started. */
  uptimeMs?: () => number;
  /** The Windows clock, for the boot cross-check only. */
  wallMs?: () => number;
};

export class TrustedClock {
  private readonly uptimeMs: () => number;
  private readonly wallMs: () => number;

  constructor(private readonly deps: TrustedClockDeps) {
    this.uptimeMs = deps.uptimeMs ?? (() => Math.floor(uptime() * 1000));
    this.wallMs = deps.wallMs ?? Date.now;
  }

  private row(): AnchorRow | undefined {
    return this.deps.db
      .prepare(
        "SELECT server_time_ms, uptime_ms, boot_wall_ms, source, high_water_ms FROM trusted_clock_anchor WHERE id = 1",
      )
      .get() as AnchorRow | undefined;
  }

  /** Time from the anchor, or why there is none, without recording anything. */
  private read():
    | { estimate: number; row: AnchorRow }
    | { reason: ClockUntrustedReason } {
    const row = this.row();
    if (!row) return { reason: "NO_ANCHOR" };
    const up = this.uptimeMs();
    if (!Number.isSafeInteger(up) || up < row.uptime_ms)
      return { reason: "NEW_BOOT" };
    const bootWall = this.wallMs() - up;
    if (Math.abs(bootWall - row.boot_wall_ms) > BOOT_DRIFT_TOLERANCE_MS)
      return { reason: "NEW_BOOT" };
    return { estimate: row.server_time_ms + (up - row.uptime_ms), row };
  }

  /**
   * A server-signed time the caller has verified, received just now. Trusted time never moves
   * back: a signed time older than the current estimate (a replayed pair, a slow reply) only
   * refreshes the boot it is measured from.
   */
  observe(serverTimeMs: number, source: TrustedClockSource): void {
    if (!Number.isSafeInteger(serverTimeMs) || serverTimeMs <= 0) return;
    const up = this.uptimeMs();
    if (!Number.isSafeInteger(up) || up < 0) return;
    const current = this.read();
    const sameBoot = "estimate" in current;
    const anchorTime = sameBoot
      ? Math.max(serverTimeMs, current.estimate)
      : serverTimeMs;
    const highWater = sameBoot
      ? Math.max(current.row.high_water_ms, anchorTime)
      : anchorTime;
    const at = new Date(this.wallMs()).toISOString();
    this.deps.db
      .prepare(
        `INSERT INTO trusted_clock_anchor (id, server_time_ms, uptime_ms, boot_wall_ms, source, high_water_ms, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET server_time_ms = excluded.server_time_ms, uptime_ms = excluded.uptime_ms,
           boot_wall_ms = excluded.boot_wall_ms, source = excluded.source, high_water_ms = excluded.high_water_ms,
           updated_at = excluded.updated_at`,
      )
      .run(anchorTime, up, this.wallMs() - up, source, highWater, at);
  }

  /** Trusted time now, never earlier than any trusted time handed out before. Records nothing. */
  now(): TrustedNow {
    const current = this.read();
    if ("reason" in current) return { trusted: false, reason: current.reason };
    return {
      trusted: true,
      nowMs: Math.max(current.estimate, current.row.high_water_ms),
      anchoredAt: current.row.server_time_ms,
      source: current.row.source,
    };
  }

  /**
   * Trusted time for something this computer records (an outage start, a journal entry): as
   * `now`, and saved as the high-water mark in the same write, so a later reading (after an app
   * restart included) is never earlier. Call inside the transaction that records it.
   */
  stamp(): TrustedNow {
    const reading = this.now();
    if (!reading.trusted) return reading;
    this.deps.db
      .prepare(
        "UPDATE trusted_clock_anchor SET high_water_ms = MAX(high_water_ms, ?) WHERE id = 1",
      )
      .run(reading.nowMs);
    return reading;
  }
}
