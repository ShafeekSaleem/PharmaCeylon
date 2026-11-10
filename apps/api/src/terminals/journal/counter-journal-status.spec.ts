import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import {
  hasOutstanding,
  journalStatusQuery,
  journalSyncView,
  journalSyncViews,
  stuckJournalWorkSource,
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
    last_received_at: null,
    stopped_sequence: null,
    stopped_outcome: null,
    stopped_error_code: null,
    stopped_since: null,
    open_stock_cases: 0,
    ...over,
  };
}

/**
 * Every table a statement reads (`FROM table alias` / `JOIN table alias`), each with the text
 * after it up to the next table read: the condition that read must carry.
 */
function tableReads(statement: Prisma.Sql) {
  const sql = statement.sql.replace(/\s+/g, " ");
  const matches = [...sql.matchAll(/\b(?:FROM|JOIN) ([a-z_]+) ([a-z])\b/g)];
  return matches.map((m, i) => ({
    table: m[1]!,
    alias: m[2]!,
    clause: sql.slice(
      m.index! + m[0].length,
      matches[i + 1]?.index ?? sql.length,
    ),
  }));
}

/**
 * Enrollment `e` is bound to the caller's tenant and branch once, in the outer WHERE, and every
 * other read, each time it appears, is joined on `e`'s tenant and branch.
 */
function expectScopedToBranch(statement: Prisma.Sql) {
  const sql = statement.sql.replace(/\s+/g, " ");
  expect(statement.values.slice(0, 2)).toEqual([TENANT, BRANCH]);
  expect(sql).toContain(
    "WHERE e.tenant_id = ?::uuid AND e.branch_id = ?::uuid",
  );
  const reads = tableReads(statement);
  expect(reads.filter((r) => r.alias === "e")).toEqual([
    expect.objectContaining({ table: "terminal_enrollment" }),
  ]);
  for (const read of reads.filter((r) => r.alias !== "e"))
    expect({
      ...read,
      scoped: read.clause.includes(
        `${read.alias}.tenant_id = e.tenant_id AND ${read.alias}.branch_id = e.branch_id`,
      ),
    }).toEqual({ ...read, scoped: true });
  return reads;
}

describe("counter journal sync status (P5 #51)", () => {
  it("reads the head, the last receipt and where the journal stopped, with bigints as numbers", () => {
    const view = journalSyncView(
      row({
        head_sequence: 41n,
        head_accepted_at: at(2),
        last_received_at: at(5),
        stopped_sequence: 42n,
        stopped_outcome: "rejected",
        stopped_error_code: "GRANT_INVALID",
        stopped_since: at(4),
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
      lastReceivedAt: at(5).getTime(),
      stoppedAt: {
        sequence: 42,
        outcome: "rejected",
        errorCode: "GRANT_INVALID",
        since: at(4).getTime(),
      },
      openStockCases: 3,
    });
  });

  it("has no head and nothing received for a counter that never sent anything", () => {
    expect(journalSyncView(row())).toMatchObject({
      head: null,
      lastReceivedAt: null,
      stoppedAt: null,
      current: true,
    });
  });

  it("keeps a held or conflicting stop as what it is", () => {
    for (const outcome of ["held", "conflict"] as const)
      expect(
        journalSyncView(
          row({
            stopped_sequence: 3,
            stopped_outcome: outcome,
            stopped_error_code: "X",
            stopped_since: at(1),
          }),
        ).stoppedAt,
      ).toEqual({
        sequence: 3,
        outcome,
        errorCode: "X",
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
    const stopped = (outcome: string) => ({
      stopped_sequence: 4,
      stopped_outcome: outcome,
      stopped_error_code: "X",
      stopped_since: at(1),
    });
    const views = journalSyncViews([
      row({ enrollment_id: "current" }),
      row({
        enrollment_id: "revoked-held",
        revoked_at: at(1),
        ...stopped("held"),
      }),
      row({
        enrollment_id: "retired-case",
        retired_at: at(1),
        open_stock_cases: 1,
      }),
      row({
        enrollment_id: "revoked-rejected",
        revoked_at: at(1),
        ...stopped("rejected"),
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
      "revoked-held",
      "retired-case",
      "revoked-rejected",
    ]);
    expect(hasOutstanding(views[0]!)).toBe(false);
  });

  it("scopes every table the status query reads, every time it reads it", () => {
    const query = journalStatusQuery(TENANT, BRANCH);
    expect(query.values).toEqual([TENANT, BRANCH]);
    const reads = expectScopedToBranch(query);
    expect(reads.map((r) => `${r.table} ${r.alias}`).sort()).toEqual([
      "offline_journal_review v",
      "offline_journal_review v",
      "offline_staff_sign_in s",
      "offline_stock_discrepancy c",
      "operational_terminal t",
      "terminal_command_receipt r",
      "terminal_enrollment e",
    ]);
    const sql = query.sql.replace(/\s+/g, " ");
    // Where it stopped: only commands past the head, the lowest sequence, most severe copy first.
    expect(sql).toContain(
      "v.record_kind = 'command' AND v.sequence > COALESCE(h.offline_sequence, 0)",
    );
    expect(sql).toContain(
      "ORDER BY v.sequence, CASE v.outcome WHEN 'conflict' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END",
    );
  });

  it("scopes the Daily work source the same way, and lists only what slice 4 can settle", () => {
    const source = stuckJournalWorkSource(TENANT, BRANCH);
    expect(source.values).toEqual([TENANT, BRANCH]);
    const reads = expectScopedToBranch(source);
    expect(reads.map((r) => `${r.table} ${r.alias}`).sort()).toEqual([
      "offline_journal_review v",
      "operational_terminal t",
      "terminal_command_receipt r",
      "terminal_counter k",
      "terminal_enrollment e",
    ]);
    const sql = source.sql.replace(/\s+/g, " ");
    expect(sql).toContain(
      "AND e.revoked_at IS NULL AND t.retired_at IS NULL AND x.outcome = 'rejected'",
    );
    // Daily work's UNION expects its 16 columns in order.
    const select = sql.slice(
      sql.indexOf("SELECT") + 6,
      sql.indexOf(" FROM terminal_enrollment e"),
    );
    expect(select.split(/,(?![^(]*\))/)).toHaveLength(16);
  });
});

describe("CounterJournalStatusService", () => {
  const user = {
    userId: "u-1",
    tenantId: TENANT,
    tokenVersion: 0,
  } as RequestUser;

  function service(
    granted: string[],
    rows: JournalStatusRow[] = [],
    timezone: string | null = "Asia/Colombo",
  ) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      branch: {
        findFirst: jest
          .fn()
          .mockResolvedValue(timezone === null ? null : { timezone }),
      },
    };
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
    expect(tx.branch.findFirst).not.toHaveBeenCalled();
  });

  it("returns the branch's timezone with the rows mapped, in one statement", async () => {
    const { svc, prisma, tx } = service(
      ["tenant.management"],
      [
        row({
          head_sequence: 7n,
          head_accepted_at: at(3),
          last_received_at: at(3),
        }),
        row({ enrollment_id: "old", revoked_at: at(0) }),
      ],
    );
    const status = await svc.list(user, BRANCH);
    expect(status).toEqual({
      timezone: "Asia/Colombo",
      enrollments: [
        expect.objectContaining({
          enrollmentId: "e-current",
          head: { sequence: 7, acceptedAt: at(3).getTime() },
        }),
      ],
    });
    // A single statement is its own snapshot: no isolation level to ask for.
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(tx.branch.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, id: BRANCH },
      select: { timezone: true },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect((tx.$queryRaw.mock.calls[0]![0] as Prisma.Sql).values).toEqual([
      TENANT,
      BRANCH,
    ]);
  });

  it("falls back to the default timezone when the branch has none", async () => {
    const { svc } = service(["tenant.management"], [], null);
    expect((await svc.list(user, BRANCH)).timezone).toBe("Asia/Colombo");
  });

  it("refuses a branch id that is not a UUID before reading", async () => {
    const { svc, access } = service(["tenant.management"]);
    await expect(svc.list(user, "not-a-branch")).rejects.toThrow();
    expect(access.resolveLive).not.toHaveBeenCalled();
  });
});
