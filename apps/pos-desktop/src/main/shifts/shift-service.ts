import { randomUUID } from "node:crypto";
import {
  shiftSummarySchema,
  type CashCount,
  type LocalShift,
  type PastShift,
  type ShiftState,
  type ShiftSummary,
} from "../../shared/ipc-contract";
import { ApiError, type ApiSession } from "../api/api-client";
import type { PosDatabase } from "../db/database";
import type { DeviceStore } from "../device/device-store";
import type { Logger } from "../logging/logger";
import { ActionFailure, explain, type TerminalService } from "../terminal/terminal-service";
import { toMinor } from "../checkout/money";

/** The server's shift record (API_CONTRACT.md, "Till shifts"). */
type ServerShift = {
  workSessionId: string;
  shiftNumber: string;
  tillId: string;
  staffUserId: string;
  staff: { id: string; fullName: string } | null;
  status: "open" | "closed";
  openedAt: string;
  openingCashMinor: number;
  openingCount: CashCount["lines"];
  previousClosedWorkSessionId: string | null;
  closedAt: string | null;
  closingCashCountMinor: number | null;
  closingCount: CashCount["lines"] | null;
  expectedCashMinor: number | null;
  varianceMinor: number | null;
  closedBy: { id: string; fullName: string } | null;
  closeKind: "self" | "assisted" | null;
  assistanceReason: string | null;
  varianceNote: string | null;
};

const past = (shift: ServerShift): PastShift => ({
  workSessionId: shift.workSessionId,
  shiftNumber: shift.shiftNumber,
  staffName: shift.staff?.fullName ?? "",
  status: shift.status,
  openedAt: shift.openedAt,
  openingCashMinor: shift.openingCashMinor,
  closedAt: shift.closedAt,
  closingCashCountMinor: shift.closingCashCountMinor,
  expectedCashMinor: shift.expectedCashMinor,
  varianceMinor: shift.varianceMinor,
  varianceNote: shift.varianceNote,
  closedByName: shift.closedBy?.fullName ?? null,
  closeKind: shift.closeKind ?? null,
  assistanceReason: shift.assistanceReason,
});
type ServerDetail = { shift: ServerShift; summary: ShiftSummary };
type ServerCurrent = {
  tillId: string;
  current: ServerDetail | null;
  lastClosed: ServerShift | null;
};

type Row = {
  work_session_id: string;
  shift_number: string | null;
  enrollment_id: string;
  branch_id: string;
  till_id: string | null;
  staff_user_id: string;
  staff_name: string;
  opened_at: string;
  opening_cash_minor: number;
  opening_count_json: string;
  previous_closed_work_session_id: string | null;
  state: "opening" | "open" | "closing" | "closed";
  expected_cash_minor: number;
  close_command_id: string | null;
  closing_cash_count_minor: number | null;
  closing_count_json: string | null;
  counter_expected_at_close_minor: number | null;
  variance_note: string | null;
  assistance_reason: string | null;
  closed_by_user_id: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  server_expected_cash_minor: number | null;
  variance_minor: number | null;
  sync: "pending" | "synced" | "failed";
  error_code: string | null;
  error_message: string | null;
  summary_json: string | null;
  summary_at: string | null;
  updated_at: string;
};

/** Refusals that mean the step didn't and won't happen as sent (`definite-refusal.ts` reasoning:
 * a close or open carries a fresh ID the server checks before anything else that could differ). */
const isDefinite = (error: unknown) => error instanceof ApiError && !error.uncertain && error.status !== 401 && error.status !== 429;

/**
 * This counter's till shifts (P2b #103): opening and closing them with the server, and the copy
 * the counter keeps so it still knows — locked, restarted or offline — whose shift is open, what
 * the drawer should hold, and whether the server has confirmed the last step.
 *
 * Writes go to SQLite before the server is asked. A close is never lost: it is saved as `closing`
 * with its command ID, and a restart (or the next refresh) resends it under that ID, which the
 * server replays. A close made for someone else can't be resent without the manager's PIN, which
 * is never stored, so it waits, clearly marked, for them.
 */
export class ShiftService {
  constructor(
    private readonly deps: {
      db: PosDatabase;
      api: ApiSession;
      terminal: TerminalService;
      device: DeviceStore;
      logger: Logger;
      now?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private counter() {
    const current = this.deps.terminal.current();
    if (!current) throw new ActionFailure("NOT_SIGNED_IN", "Sign in at this counter first.");
    return current;
  }

  private path(workSessionId: string, rest = "") {
    return `/terminals/sessions/${workSessionId}/shifts${rest}`;
  }

  // ── reading ───────────────────────────────────────────────────────────────────────────────

  /** What this counter knows, without asking the server. */
  state(): ShiftState {
    const enrollmentId = this.deps.device.read()?.identity.enrollmentId;
    if (!enrollmentId) return { current: null, lastClosed: null, unsynced: [] };
    const rows = this.deps.db
      .prepare("SELECT * FROM till_shift WHERE enrollment_id = ? ORDER BY opened_at")
      .all(enrollmentId) as Row[];
    const live = rows.filter((r) => r.state !== "closed");
    const closed = rows.filter((r) => r.state === "closed");
    const lastClosed = closed.sort((a, b) => (a.closed_at ?? "").localeCompare(b.closed_at ?? "")).at(-1);
    return {
      current: live.at(-1) ? this.view(live.at(-1)!) : null,
      lastClosed: lastClosed ? this.view(lastClosed) : null,
      unsynced: rows.filter((r) => r.sync !== "synced").map((r) => this.view(r)),
    };
  }

  private view(row: Row): LocalShift {
    let summary: ShiftSummary | null = null;
    if (row.summary_json) {
      const parsed = shiftSummarySchema.safeParse(JSON.parse(row.summary_json));
      summary = parsed.success ? parsed.data : null;
    }
    return {
      workSessionId: row.work_session_id,
      shiftNumber: row.shift_number,
      staffUserId: row.staff_user_id,
      staffName: row.staff_name,
      openedAt: row.opened_at,
      openingCashMinor: row.opening_cash_minor,
      openingCount: JSON.parse(row.opening_count_json) as CashCount["lines"],
      status: row.state,
      sync: row.sync,
      error: row.error_code ? { code: row.error_code, message: row.error_message ?? "" } : null,
      expectedCashMinor: row.expected_cash_minor,
      closedAt: row.closed_at,
      closedByName: row.closed_by_name,
      closingCashCountMinor: row.closing_cash_count_minor,
      serverExpectedCashMinor: row.server_expected_cash_minor,
      varianceMinor: row.variance_minor,
      varianceNote: row.variance_note,
      assistanceReason: row.assistance_reason,
      needsManagerPin: row.state === "closing" && row.sync !== "synced" && row.assistance_reason !== null,
      summary,
      summaryAt: row.summary_at,
    };
  }

  private row(workSessionId: string): Row | undefined {
    return this.deps.db.prepare("SELECT * FROM till_shift WHERE work_session_id = ?").get(workSessionId) as
      | Row
      | undefined;
  }

  // ── talking to the server ─────────────────────────────────────────────────────────────────

  /**
   * Resends any close this counter saved but the server hasn't confirmed (a restart mid-close
   * lands here), then adopts what the server says is open on the till.
   */
  async refresh(): Promise<ShiftState> {
    const { staff, identity } = this.counter();
    for (const row of this.state().unsynced) {
      if (row.status !== "closing" || row.needsManagerPin) continue;
      const stored = this.row(row.workSessionId)!;
      // Only the person who closed it can resend it: anyone else would be an assisted close.
      if (stored.closed_by_user_id !== staff.staffUserId) continue;
      await this.sendClose(stored, undefined).catch(() => undefined);
    }
    const server = await this.deps.api.request<ServerCurrent>("GET", this.path(staff.workSessionId, "/current"), {
      branchId: identity.branchId,
    });
    this.adopt(server, identity.enrollmentId, identity.branchId);
    return this.state();
  }

  /** Brings the local copy in line with the server's answer; the server is the record online. */
  private adopt(server: ServerCurrent, enrollmentId: string, branchId: string) {
    const at = this.now().toISOString();
    const open = server.current;
    this.deps.db.transaction(() => {
      if (open) this.upsertOpen(open, enrollmentId, branchId, at);
      if (server.lastClosed) this.upsertClosed(server.lastClosed, enrollmentId, branchId, null, at);
      // Steps this counter thinks are live that the server no longer has open.
      const live = this.deps.db
        .prepare("SELECT * FROM till_shift WHERE enrollment_id = ? AND state IN ('opening', 'open')")
        .all(enrollmentId) as Row[];
      for (const row of live) {
        if (open && row.work_session_id === open.shift.workSessionId) continue;
        if (server.lastClosed?.workSessionId === row.work_session_id) continue;
        if (row.state === "opening") {
          // An open the server never took: nothing happened, so nothing is kept.
          this.deps.db.prepare("DELETE FROM till_shift_posting WHERE work_session_id = ?").run(row.work_session_id);
          this.deps.db.prepare("DELETE FROM till_shift WHERE work_session_id = ?").run(row.work_session_id);
        }
        // An open shift the server closed some other way is fetched on its own (below).
      }
    })();
    const orphaned = (
      this.deps.db
        .prepare("SELECT work_session_id FROM till_shift WHERE enrollment_id = ? AND state = 'open'")
        .all(enrollmentId) as { work_session_id: string }[]
    ).filter((r) => r.work_session_id !== open?.shift.workSessionId);
    for (const row of orphaned) void this.fetchClosed(row.work_session_id, enrollmentId, branchId);
  }

  private async fetchClosed(workSessionId: string, enrollmentId: string, branchId: string) {
    const current = this.deps.terminal.current();
    if (!current) return;
    try {
      const detail = await this.deps.api.request<ServerDetail>(
        "GET",
        this.path(current.staff.workSessionId, `/${workSessionId}`),
        { branchId },
      );
      if (detail.shift.status === "closed")
        this.upsertClosed(detail.shift, enrollmentId, branchId, detail.summary, this.now().toISOString());
    } catch (error) {
      this.deps.logger.warn("shift.fetch_closed_failed", { code: explain(error).code });
    }
  }

  private upsertOpen(detail: ServerDetail, enrollmentId: string, branchId: string, at: string) {
    const { shift, summary } = detail;
    const existing = this.row(shift.workSessionId);
    if (existing?.state === "closing") {
      // A close is saved here and not confirmed yet: keep it; only the totals move.
      this.deps.db
        .prepare("UPDATE till_shift SET summary_json = ?, summary_at = ?, updated_at = ? WHERE work_session_id = ?")
        .run(JSON.stringify(summary), at, at, shift.workSessionId);
      return;
    }
    if (existing) {
      this.deps.db
        .prepare(
          `UPDATE till_shift SET state = 'open', sync = 'synced', error_code = NULL, error_message = NULL,
             shift_number = ?, till_id = ?, summary_json = ?, summary_at = ?, updated_at = ? WHERE work_session_id = ?`,
        )
        .run(shift.shiftNumber, shift.tillId, JSON.stringify(summary), at, at, shift.workSessionId);
      return;
    }
    // A shift opened before this counter kept a copy (or on a previous install): it is imported
    // with the server's expected cash as the starting point of the counter's own figure (D7b).
    this.deps.db
      .prepare(
        `INSERT INTO till_shift (work_session_id, shift_number, enrollment_id, branch_id, till_id, staff_user_id, staff_name, opened_at,
           opening_cash_minor, opening_count_json, previous_closed_work_session_id, state, expected_cash_minor, sync,
           summary_json, summary_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 'synced', ?, ?, ?)`,
      )
      .run(
        shift.workSessionId,
        shift.shiftNumber,
        enrollmentId,
        branchId,
        shift.tillId,
        shift.staffUserId,
        shift.staff?.fullName ?? "",
        shift.openedAt,
        shift.openingCashMinor,
        JSON.stringify(shift.openingCount),
        shift.previousClosedWorkSessionId,
        summary.expectedCashMinor,
        JSON.stringify(summary),
        at,
        at,
      );
  }

  private upsertClosed(
    shift: ServerShift,
    enrollmentId: string,
    branchId: string,
    summary: ShiftSummary | null,
    at: string,
  ) {
    const existing = this.row(shift.workSessionId);
    const fields = [
      shift.closedAt,
      shift.closedBy?.id ?? null,
      shift.closedBy?.fullName ?? null,
      shift.closingCashCountMinor,
      JSON.stringify(shift.closingCount ?? []),
      shift.expectedCashMinor,
      shift.varianceMinor,
      shift.varianceNote,
      shift.assistanceReason,
    ] as const;
    if (existing) {
      if (existing.state === "closed" && existing.sync === "synced" && !summary) return;
      this.deps.db
        .prepare(
          `UPDATE till_shift SET state = 'closed', sync = 'synced', error_code = NULL, error_message = NULL,
             shift_number = ?, close_command_id = COALESCE(close_command_id, ?), closed_at = ?, closed_by_user_id = ?, closed_by_name = ?,
             closing_cash_count_minor = ?, closing_count_json = ?, server_expected_cash_minor = ?, variance_minor = ?,
             variance_note = ?, assistance_reason = ?,
             summary_json = COALESCE(?, summary_json), summary_at = COALESCE(?, summary_at), updated_at = ?
           WHERE work_session_id = ?`,
        )
        .run(
          shift.shiftNumber,
          randomUUID(),
          ...fields,
          summary ? JSON.stringify(summary) : null,
          summary ? at : null,
          at,
          shift.workSessionId,
        );
      return;
    }
    this.deps.db
      .prepare(
        `INSERT INTO till_shift (work_session_id, shift_number, enrollment_id, branch_id, till_id, staff_user_id, staff_name, opened_at,
           opening_cash_minor, opening_count_json, previous_closed_work_session_id, state, expected_cash_minor,
           close_command_id, closed_at, closed_by_user_id, closed_by_name, closing_cash_count_minor, closing_count_json,
           server_expected_cash_minor, variance_minor, variance_note, assistance_reason, sync, summary_json, summary_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?)`,
      )
      .run(
        shift.workSessionId,
        shift.shiftNumber,
        enrollmentId,
        branchId,
        shift.tillId,
        shift.staffUserId,
        shift.staff?.fullName ?? "",
        shift.openedAt,
        shift.openingCashMinor,
        JSON.stringify(shift.openingCount),
        shift.previousClosedWorkSessionId,
        shift.expectedCashMinor ?? 0,
        randomUUID(),
        ...fields,
        summary ? JSON.stringify(summary) : null,
        summary ? at : null,
        at,
      );
  }

  /**
   * Opens the signed-in person's shift with their own PIN and the counted drawer. Saved here as
   * `opening` first, so a lost answer is settled by the next refresh rather than guessed at.
   */
  async open(pin: string, count: CashCount): Promise<ShiftState> {
    const { staff, identity } = this.counter();
    const state = this.state();
    if (state.current && state.current.status !== "opening")
      throw new ActionFailure(
        "SHIFT_ALREADY_OPEN",
        state.current.staffUserId === staff.staffUserId
          ? "Your shift is already open on this till."
          : `${state.current.staffName}'s shift is still open on this till. They count the drawer and close it first.`,
      );
    if (state.current) this.forget(state.current.workSessionId);
    const workSessionId = randomUUID();
    const at = this.now().toISOString();
    this.deps.db
      .prepare(
        `INSERT INTO till_shift (work_session_id, enrollment_id, branch_id, staff_user_id, staff_name, opened_at,
           opening_cash_minor, opening_count_json, previous_closed_work_session_id, state, expected_cash_minor, sync, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opening', ?, 'pending', ?)`,
      )
      .run(
        workSessionId,
        identity.enrollmentId,
        identity.branchId,
        staff.staffUserId,
        staff.staffName,
        at,
        count.totalMinor,
        JSON.stringify(count.lines),
        state.lastClosed?.workSessionId ?? null,
        count.totalMinor,
        at,
      );
    try {
      const detail = await this.deps.api.request<ServerDetail>("POST", this.path(staff.workSessionId), {
        branchId: identity.branchId,
        body: { shiftId: workSessionId, pin, openingCount: count },
      });
      const now = this.now().toISOString();
      this.deps.db
        .prepare(
          `UPDATE till_shift SET state = 'open', sync = 'synced', shift_number = ?, till_id = ?, opened_at = ?,
             previous_closed_work_session_id = ?, summary_json = ?, summary_at = ?, updated_at = ? WHERE work_session_id = ?`,
        )
        .run(
          detail.shift.shiftNumber,
          detail.shift.tillId,
          detail.shift.openedAt,
          detail.shift.previousClosedWorkSessionId,
          JSON.stringify(detail.summary),
          now,
          now,
          workSessionId,
        );
      this.deps.logger.info("shift.opened", { workSessionId });
      return this.state();
    } catch (error) {
      if (isDefinite(error)) {
        this.forget(workSessionId);
        throw error;
      }
      this.markError(workSessionId, "pending", error);
      throw new ActionFailure(
        "SHIFT_OPEN_UNCERTAIN",
        "The server didn't answer. Your shift may have opened: check again before counting the drawer twice.",
      );
    }
  }

  /**
   * Closes the open shift with the counted drawer. The close is saved here, with its command ID,
   * before it is sent; it is never lost on a restart. Someone else's shift needs `assistance`.
   */
  async close(
    count: CashCount,
    options: { varianceNote?: string; assistance?: { pin: string; reason: string } } = {},
  ): Promise<ShiftState> {
    const { staff } = this.counter();
    const current = this.state().current;
    if (!current || current.status === "opening")
      throw new ActionFailure("SHIFT_NOT_OPEN", "There's no open shift on this till to close.");
    if (current.status === "closing")
      throw new ActionFailure("SHIFT_CLOSE_PENDING", "This shift's close is saved and waiting for the server. Send it again instead.");
    const assisted = current.staffUserId !== staff.staffUserId;
    if (assisted && !options.assistance)
      throw new ActionFailure(
        "SHIFT_ASSISTANCE_REQUIRED",
        `This is ${current.staffName}'s shift. A manager closes it for them with their own PIN and a reason.`,
      );
    if (!assisted && options.assistance)
      throw new ActionFailure("INVALID_COMMAND", "Your own shift closes without a manager.");
    const at = this.now().toISOString();
    this.deps.db
      .prepare(
        `UPDATE till_shift SET state = 'closing', sync = 'pending', error_code = NULL, error_message = NULL,
           close_command_id = ?, closing_cash_count_minor = ?, closing_count_json = ?,
           counter_expected_at_close_minor = expected_cash_minor, variance_note = ?, assistance_reason = ?,
           closed_by_user_id = ?, closed_by_name = ?, closed_at = ?, updated_at = ?
         WHERE work_session_id = ? AND state = 'open'`,
      )
      .run(
        randomUUID(),
        count.totalMinor,
        JSON.stringify(count.lines),
        options.varianceNote?.trim() || null,
        options.assistance?.reason.trim() ?? null,
        staff.staffUserId,
        staff.staffName,
        at,
        at,
        current.workSessionId,
      );
    await this.sendClose(this.row(current.workSessionId)!, options.assistance?.pin);
    return this.state();
  }

  /** Sends an unconfirmed close again, under its saved command ID. */
  async retryClose(pin?: string): Promise<ShiftState> {
    const { staff } = this.counter();
    const current = this.state().current;
    if (!current || current.status !== "closing")
      throw new ActionFailure("SHIFT_CLOSE_NOT_PENDING", "No close is waiting to be confirmed.");
    const row = this.row(current.workSessionId)!;
    if (row.closed_by_user_id !== staff.staffUserId)
      throw new ActionFailure(
        "SHIFT_CLOSE_OTHER_STAFF",
        `${row.closed_by_name ?? "The person who counted"} closed this shift. They confirm the close when they sign in.`,
      );
    if (row.assistance_reason !== null && !pin)
      throw new ActionFailure("PIN_REQUIRED", "Enter your PIN to send the close again.");
    await this.sendClose(row, pin);
    return this.state();
  }

  private async sendClose(row: Row, pin: string | undefined): Promise<void> {
    const { staff, identity } = this.counter();
    const count: CashCount = {
      totalMinor: row.closing_cash_count_minor!,
      lines: JSON.parse(row.closing_count_json!) as CashCount["lines"],
    };
    try {
      const detail = await this.deps.api.request<ServerDetail>(
        "POST",
        this.path(staff.workSessionId, `/${row.work_session_id}/close`),
        {
          branchId: identity.branchId,
          body: {
            commandId: row.close_command_id,
            closingCount: count,
            counterExpectedCashMinor: row.counter_expected_at_close_minor,
            ...(row.variance_note ? { varianceNote: row.variance_note } : {}),
            ...(row.assistance_reason && pin ? { assistance: { pin, reason: row.assistance_reason } } : {}),
          },
        },
      );
      this.deps.db.transaction(() => {
        this.upsertClosed(detail.shift, row.enrollment_id, row.branch_id, detail.summary, this.now().toISOString());
      })();
      this.deps.logger.info("shift.closed", { workSessionId: row.work_session_id });
    } catch (error) {
      if (error instanceof ApiError && error.code === "SHIFT_ALREADY_CLOSED") {
        // Closed by another close (a manager's, or one from before a reinstall): take the server's.
        this.markError(row.work_session_id, "failed", error);
        await this.fetchClosed(row.work_session_id, row.enrollment_id, row.branch_id);
        throw error;
      }
      if (isDefinite(error)) {
        // Refused (a wrong PIN, no permission): the close didn't happen, so the shift is open
        // again, with the reason shown until the next try.
        const explained = explain(error);
        this.deps.db
          .prepare(
            `UPDATE till_shift SET state = 'open', sync = 'failed', error_code = ?, error_message = ?,
               close_command_id = NULL, closing_cash_count_minor = NULL, closing_count_json = NULL,
               counter_expected_at_close_minor = NULL, variance_note = NULL, assistance_reason = NULL,
               closed_by_user_id = NULL, closed_by_name = NULL, closed_at = NULL, updated_at = ?
             WHERE work_session_id = ?`,
          )
          .run(explained.code, explained.message, this.now().toISOString(), row.work_session_id);
        throw error;
      }
      this.markError(row.work_session_id, "pending", error);
      throw new ActionFailure(
        "SHIFT_CLOSE_UNCERTAIN",
        "The close is saved on this counter but the server hasn't confirmed it. It's sent again automatically; nothing is lost.",
      );
    }
  }

  private markError(workSessionId: string, sync: "pending" | "failed", error: unknown) {
    const explained = explain(error);
    this.deps.db
      .prepare("UPDATE till_shift SET sync = ?, error_code = ?, error_message = ?, updated_at = ? WHERE work_session_id = ?")
      .run(sync, explained.code, explained.message, this.now().toISOString(), workSessionId);
  }

  private forget(workSessionId: string) {
    this.deps.db.transaction(() => {
      this.deps.db.prepare("DELETE FROM till_shift_posting WHERE work_session_id = ?").run(workSessionId);
      this.deps.db.prepare("DELETE FROM till_shift WHERE work_session_id = ?").run(workSessionId);
    })();
  }

  /** The till's shifts from the server, newest first (Past shifts). */
  async list(): Promise<PastShift[]> {
    const { staff, identity } = this.counter();
    const rows = await this.deps.api.request<ServerShift[]>("GET", this.path(staff.workSessionId), {
      branchId: identity.branchId,
    });
    return rows.map(past);
  }

  /** One shift on this till with its totals, from the server. */
  async detail(workSessionId: string): Promise<{ shift: PastShift; summary: ShiftSummary }> {
    const { staff, identity } = this.counter();
    const detail = await this.deps.api.request<ServerDetail>(
      "GET",
      this.path(staff.workSessionId, `/${workSessionId}`),
      { branchId: identity.branchId },
    );
    return { shift: past(detail.shift), summary: detail.summary };
  }

  /**
   * The open shift's figures for an X report: the server's, fresh, when it answers (they're kept
   * as the counter's copy too), or the counter's last copy, marked as such.
   */
  async xReport(): Promise<{ shift: LocalShift; summary: ShiftSummary; current: boolean }> {
    this.counter();
    const before = this.state().current;
    if (!before || before.status === "opening")
      throw new ActionFailure("SHIFT_NOT_OPEN", "There's no open shift on this till to report on.");
    let current = true;
    try {
      await this.refresh();
    } catch {
      current = false;
    }
    const shift = this.state().current ?? before;
    if (!shift.summary)
      throw new ActionFailure("SHIFT_FIGURES_UNAVAILABLE", "The server hasn't sent this shift's figures yet. Try again when it's reachable.");
    return { shift, summary: shift.summary, current };
  }

  // ── the counter's own running expected cash ──────────────────────────────────────────────

  /** A completed counter sale: its cash in and change out move this counter's own figure, once. */
  recordSale(sale: { saleId: string; changeDue: string; payments: { method: string; amount: string }[] }, sellerId: string) {
    const cashIn = sale.payments
      .filter((p) => p.method === "cash" && toMinor(p.amount) > 0)
      .reduce((sum, p) => sum + toMinor(p.amount), 0);
    this.post(sale.saleId, "sale", sellerId, { cashIn, change: toMinor(sale.changeDue), cashOut: 0 });
  }

  /** A refund executed here: the cash it paid back leaves this counter's own figure, once. */
  recordRefund(refundRequestId: string, refundedTo: { method: string; amountMinor: number }[], executorId: string) {
    const cashOut = refundedTo.filter((r) => r.method === "cash").reduce((sum, r) => sum + r.amountMinor, 0);
    this.post(`refund:${refundRequestId}`, "refund", executorId, { cashIn: 0, change: 0, cashOut });
  }

  private post(
    id: string,
    kind: "sale" | "refund",
    staffUserId: string,
    cash: { cashIn: number; change: number; cashOut: number },
  ) {
    const enrollmentId = this.deps.device.read()?.identity.enrollmentId;
    const shift = this.deps.db
      .prepare(
        "SELECT work_session_id FROM till_shift WHERE enrollment_id = ? AND state = 'open' AND staff_user_id = ? ORDER BY opened_at DESC",
      )
      .get(enrollmentId ?? "", staffUserId) as { work_session_id: string } | undefined;
    if (!shift) {
      this.deps.logger.warn("shift.posting_without_shift", { kind });
      return;
    }
    this.deps.db.transaction(() => {
      const inserted = this.deps.db
        .prepare(
          `INSERT OR IGNORE INTO till_shift_posting (id, work_session_id, kind, cash_in_minor, change_minor, cash_out_minor, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, shift.work_session_id, kind, cash.cashIn, cash.change, cash.cashOut, this.now().toISOString());
      if (inserted.changes === 0) return;
      this.deps.db
        .prepare(
          "UPDATE till_shift SET expected_cash_minor = expected_cash_minor + ? - ? - ?, updated_at = ? WHERE work_session_id = ?",
        )
        .run(cash.cashIn, cash.change, cash.cashOut, this.now().toISOString(), shift.work_session_id);
    })();
  }
}
