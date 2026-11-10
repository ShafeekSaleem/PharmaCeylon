import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import {
  hasOutstanding,
  journalStatusQuery,
  journalSyncView,
  journalSyncViews,
  type JournalStatusRow,
} from "./counter-journal-status";
import { CounterJournalStatusService } from "./counter-journal-status.service";

const TENANT = "11111111-1111-4111-8111-111111111111";
const BRANCH = "22222222-2222-4222-8222-222222222222";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 8, minute));

function row(over: Partial<JournalStatusRow> = {}): JournalStatusRow {
  return {
    enrollment_id: "e-current",
    terminal_id: "t-1",
    terminal_label: "FRONT-PC",
    register_id: "r-1",
    revoked_at: null,
    retired_at: null,
    head_sequence: null,
    head_accepted_at: null,
    last_upload_at: null,
    waiting: 0,
    needs_review: 0,
    stuck_sequence: null,
    stuck_outcome: null,
    stuck_error_code: null,
    stuck_since: null,
    open_stock_cases: 0,
    ...over,
  };
}

describe("counter journal sync status (P5 #51)", () => {
  it("reads the head, the last upload and what is waiting, with Postgres bigints as numbers", () => {
    const view = journalSyncView(
      row({
        head_sequence: 41n,
        head_accepted_at: at(2),
        last_upload_at: at(5),
        waiting: 2,
        needs_review: 1,
        stuck_sequence: 42n,
        stuck_outcome: "rejected",
        stuck_error_code: "GRANT_INVALID",
        stuck_since: at(4),
        open_stock_cases: 3,
      }),
    );
    expect(view).toEqual({
      enrollmentId: "e-current",
      terminalId: "t-1",
      terminalLabel: "FRONT-PC",
      registerId: "r-1",
      current: true,
      revokedAt: null,
      retiredAt: null,
      head: { sequence: 41, acceptedAt: at(2).getTime() },
      lastUploadAt: at(5).getTime(),
      waiting: 2,
      needsReview: 1,
      stuck: {
        sequence: 42,
        outcome: "rejected",
        errorCode: "GRANT_INVALID",
        since: at(4).getTime(),
      },
      openStockCases: 3,
    });
  });

  it("has no head and no last upload for a counter that never sent anything", () => {
    expect(journalSyncView(row())).toMatchObject({
      head: null,
      lastUploadAt: null,
      stuck: null,
      current: true,
    });
  });

  it("names a conflict as a conflict", () => {
    const view = journalSyncView(
      row({
        stuck_sequence: 3,
        stuck_outcome: "conflict",
        stuck_error_code: "REPLAY_CONFLICT",
        stuck_since: at(1),
      }),
    );
    expect(view.stuck).toEqual({
      sequence: 3,
      outcome: "conflict",
      errorCode: "REPLAY_CONFLICT",
      since: at(1).getTime(),
    });
  });

  it("is not current once the key is revoked or the computer retired", () => {
    expect(journalSyncView(row({ revoked_at: at(1) }))).toMatchObject({
      current: false,
      revokedAt: at(1).getTime(),
    });
    expect(journalSyncView(row({ retired_at: at(2) }))).toMatchObject({
      current: false,
      retiredAt: at(2).getTime(),
    });
  });

  it("lists current enrollments, and earlier ones only while something of theirs is unsettled", () => {
    const views = journalSyncViews([
      row({ enrollment_id: "current" }),
      row({ enrollment_id: "revoked-waiting", revoked_at: at(1), waiting: 2 }),
      row({
        enrollment_id: "retired-case",
        retired_at: at(1),
        open_stock_cases: 1,
      }),
      row({
        enrollment_id: "revoked-review",
        revoked_at: at(1),
        needs_review: 1,
      }),
      row({
        enrollment_id: "revoked-settled",
        revoked_at: at(1),
        head_sequence: 9,
        head_accepted_at: at(0),
      }),
    ]);
    expect(views.map((v) => v.enrollmentId)).toEqual([
      "current",
      "revoked-waiting",
      "retired-case",
      "revoked-review",
    ]);
    expect(hasOutstanding(views[0]!)).toBe(false);
  });

  it("scopes every table it reads by the caller's tenant and branch", () => {
    const query = journalStatusQuery(TENANT, BRANCH);
    expect(query.values).toEqual([TENANT, BRANCH]);
    const sql = query.sql.replace(/\s+/g, " ");
    expect(sql).toContain(
      "WHERE e.tenant_id = ?::uuid AND e.branch_id = ?::uuid",
    );
    for (const [table, alias] of [
      ["operational_terminal", "t"],
      ["terminal_command_receipt", "r"],
      ["offline_journal_review", "v"],
      ["offline_staff_sign_in", "s"],
      ["offline_stock_discrepancy", "c"],
    ]) {
      expect(sql).toContain(`${table} ${alias}`);
      expect(sql).toContain(
        `${alias}.tenant_id = e.tenant_id AND ${alias}.branch_id = e.branch_id`,
      );
    }
    // Only commands past the head count, and only rejected or conflicting ones need review.
    expect(sql).toContain(
      "v.record_kind = 'command' AND v.sequence > COALESCE(h.offline_sequence, 0)",
    );
    expect(sql).toContain(
      "v.outcome IN ('rejected', 'conflict') AND v.sequence > COALESCE(h.offline_sequence, 0)",
    );
  });
});

describe("CounterJournalStatusService", () => {
  const user = {
    userId: "u-1",
    tenantId: TENANT,
    tokenVersion: 0,
  } as RequestUser;

  function service(granted: string[], rows: JournalStatusRow[] = []) {
    const tx = { $queryRaw: jest.fn().mockResolvedValue(rows) };
    const prisma = {
      $transaction: jest.fn((run: (t: typeof tx) => unknown) => run(tx)),
    };
    const access = {
      resolveLive: jest
        .fn()
        .mockResolvedValue({ has: (key: string) => granted.includes(key) }),
    };
    return {
      svc: new CounterJournalStatusService(prisma as never, access as never),
      prisma,
      access,
      tx,
    };
  }

  it("needs tenant.management, live at the branch, and reads nothing without it", async () => {
    const { svc, tx, access } = service(["terminal.execute"]);
    await expect(svc.list(user, BRANCH)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(access.resolveLive).toHaveBeenCalledWith(
      user,
      BRANCH,
      expect.anything(),
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("reads the branch in one repeatable-read snapshot and maps the rows", async () => {
    const { svc, prisma, tx } = service(
      ["tenant.management"],
      [
        row({
          head_sequence: 7n,
          head_accepted_at: at(3),
          last_upload_at: at(3),
        }),
        row({ enrollment_id: "old", revoked_at: at(0) }),
      ],
    );
    const views = await svc.list(user, BRANCH);
    expect(views).toEqual([
      expect.objectContaining({
        enrollmentId: "e-current",
        head: { sequence: 7, acceptedAt: at(3).getTime() },
      }),
    ]);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect((tx.$queryRaw.mock.calls[0]![0] as Prisma.Sql).values).toEqual([
      TENANT,
      BRANCH,
    ]);
  });

  it("refuses a branch id that is not a UUID before reading", async () => {
    const { svc, access } = service(["tenant.management"]);
    await expect(svc.list(user, "not-a-branch")).rejects.toThrow();
    expect(access.resolveLive).not.toHaveBeenCalled();
  });
});
