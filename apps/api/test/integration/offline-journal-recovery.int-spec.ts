import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type {
  JournalPosition,
  OfflineJournalCommand,
  OfflineJournalRecoveryCompletion,
  OfflineJournalRecoveryReport,
  OfflineStaffSignIn,
  Signed,
} from "@pharmaceylon/shared";
import { OfflineJournalRecoveryService } from "../../src/terminals/journal/journal-recovery.service";
import { journalHash } from "../../src/terminals/journal/offline-journal-wire";
import { OfflineActivationClearance } from "../../src/terminals/offline-activation.service";
import {
  acceptedJournalState,
  issueOfflineAuthority,
} from "../../src/terminals/offline-authority-issuance";
import { terminalDevice } from "../fixtures/terminal-device";
import {
  access,
  activation,
  assignments,
  attest,
  audit,
  counter,
  offlineJournal,
  prisma,
  proofs,
  signer,
  sync,
  trust,
  onHand,
  type Counter,
} from "./offline-counter.kit";

/**
 * P5 #51, approved D11 (decisions of 2026-11-10), against PostgreSQL: a restored counter's
 * journal recovery (report, approval by the owner or a delegated manager, completion), and the
 * missing-journal sign-off that lets another counter take over offline selling.
 */
const recovery = new OfflineJournalRecoveryService(
  prisma as never,
  access,
  audit,
  assignments,
);
const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(run, { timeout: 15_000 });

afterAll(async () => {
  await prisma.$disconnect();
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { response?: { code?: string } }) =>
      error.response?.code ?? String(error),
  );

/** A counter with an accepted journal: shift open and two sales. */
async function acceptedJournal(c: Counter) {
  const j = offlineJournal(c);
  const signIn = j.signIn(c.cashier.userId, randomUUID());
  const open = j.open(signIn, 100_000);
  // The computer is backed up here (after the shift opened); then it sells twice and syncs.
  const backup = j.fork();
  const saleA = j.sale(signIn, [[c.batches.main, 2]]);
  const saleB = j.sale(signIn, [[c.batches.main, 1]]);
  const reply = await sync(c, {
    staffSignIns: [signIn],
    commands: [open, saleA, saleB],
  });
  expect(reply.payload.committedThroughSequence).toBe(3);
  return {
    j,
    backup,
    signIn,
    open,
    saleA,
    saleB,
    head: {
      sequence: 3,
      hash: reply.payload.committedThroughHash,
    } as JournalPosition,
  };
}

const position = (entry: Signed<OfflineJournalCommand>): JournalPosition => ({
  sequence: entry.payload.sequence,
  hash: journalHash(entry.payload),
});

function signedReport(
  c: Counter,
  parts: Pick<
    OfflineJournalRecoveryReport,
    "serverHead" | "commonPrefix" | "localHead"
  >,
) {
  return c.device.sign<OfflineJournalRecoveryReport>(
    {
      contractVersion: 1,
      kind: "offline_journal_recovery_report",
      reportId: randomUUID(),
      identity: c.identity,
      reportedAt: Date.now(),
      ...parts,
    },
    c.identity.keyId,
  );
}

const upload = (
  c: Counter,
  report: Signed<OfflineJournalRecoveryReport>,
  unmatched: Signed<OfflineJournalCommand>[] = [],
  staffSignIns: Signed<OfflineStaffSignIn>[] = [],
) =>
  recovery.report(c.cashier, c.fx.mainBranchId, {
    report,
    unmatched,
    staffSignIns,
  });

function signedCompletion(
  c: Counter,
  recoveryId: string,
  journalHead: JournalPosition,
  setAsideThrough: JournalPosition,
) {
  return c.device.sign<OfflineJournalRecoveryCompletion>(
    {
      contractVersion: 1,
      kind: "offline_journal_recovery_completion",
      recoveryId,
      identity: c.identity,
      completedAt: Date.now(),
      journalHead,
      setAsideThrough,
      offlineAuthorityRemoved: true,
    },
    c.identity.keyId,
  );
}

const renew = (c: Counter) =>
  issueOfflineAuthority(prisma as never, access, {
    signer,
    defaultVatRatePercent: 18,
    authenticate: async () => ({
      identity: c.identity,
      commandId: randomUUID(),
    }),
    readState: acceptedJournalState,
  });

describe("restored counter journal recovery (D11)", () => {
  it("hands the accepted entries back, refuses authority while open, and needs the owner or a delegated manager", async () => {
    const c = await counter({ main: 40 });
    const { head, open, saleA, saleB } = await acceptedJournal(c);

    // What the restored computer fetches: its own signed entries and the sign-in they cite.
    const page = await recovery.chain(c.cashier, c.fx.mainBranchId, {
      identity: c.identity,
      afterSequence: 1,
      limit: 100,
    });
    expect(page.head).toEqual(head);
    expect(page.entries.map((e) => e.payload.commandId)).toEqual([
      saleA.payload.commandId,
      saleB.payload.commandId,
    ]);
    expect(page.staffSignIns).toHaveLength(1);
    expect(
      (
        await recovery.chain(c.cashier, c.fx.mainBranchId, {
          identity: c.identity,
          afterSequence: 0,
          limit: 1,
        })
      ).entries,
    ).toHaveLength(1);

    // The backup ended at the shift open: a prefix of the server's chain, nothing unmatched.
    const report = signedReport(c, {
      serverHead: head,
      commonPrefix: position(open),
      localHead: position(open),
    });
    const reported = await upload(c, report);
    expect(reported).toMatchObject({
      status: "awaiting_approval",
      unmatched: 0,
      received: 0,
      serverHead: head,
    });
    // Resending the same report is the same recovery.
    expect((await upload(c, report)).recoveryId).toBe(reported.recoveryId);
    expect(await code(renew(c))).toBe("RECONCILIATION_REQUIRED");

    const approve = {
      reason: "Restored from last night's backup; nothing was sold on it.",
      expectedServerHeadSequence: 3,
      expectedUnmatched: 0,
    };
    expect(
      await code(
        recovery.approve(
          c.cashier,
          c.fx.mainBranchId,
          reported.recoveryId,
          approve,
        ),
      ),
    ).toBe("OFFLINE_ASSIGNMENT_NOT_DELEGATED");
    expect(
      await code(
        recovery.approve(
          c.manager,
          c.fx.mainBranchId,
          reported.recoveryId,
          approve,
        ),
      ),
    ).toBe("OFFLINE_ASSIGNMENT_NOT_DELEGATED");
    await assignments.delegate(c.owner, c.fx.mainBranchId, c.manager.userId);
    const approved = await recovery.approve(
      c.manager,
      c.fx.mainBranchId,
      reported.recoveryId,
      approve,
    );
    expect(approved).toMatchObject({
      status: "approved",
      restoredEntries: 2,
      approval: { authority: "delegated_manager" },
    });
    // Approval is final, and still no authority until the counter completes.
    expect(
      await code(
        recovery.approve(
          c.owner,
          c.fx.mainBranchId,
          reported.recoveryId,
          approve,
        ),
      ),
    ).toBe("JOURNAL_RECOVERY_NOT_APPROVED");
    expect(await code(renew(c))).toBe("RECONCILIATION_REQUIRED");

    // A completion must state exactly the approved positions.
    const wrong = signedCompletion(
      c,
      reported.recoveryId,
      position(open),
      position(open),
    );
    expect(
      await code(
        recovery.complete(c.cashier, c.fx.mainBranchId, reported.recoveryId, {
          completion: wrong,
        }),
      ),
    ).toBe("JOURNAL_RECOVERY_INVALID");
    const completion = signedCompletion(
      c,
      reported.recoveryId,
      head,
      position(open),
    );
    const done = await recovery.complete(
      c.cashier,
      c.fx.mainBranchId,
      reported.recoveryId,
      { completion },
    );
    expect(done.status).toBe("recovered");
    expect(
      (
        await recovery.complete(
          c.cashier,
          c.fx.mainBranchId,
          reported.recoveryId,
          { completion },
        )
      ).status,
    ).toBe("recovered");
    const other = signedCompletion(
      c,
      reported.recoveryId,
      head,
      position(open),
    );
    expect(
      await code(
        recovery.complete(c.cashier, c.fx.mainBranchId, reported.recoveryId, {
          completion: other,
        }),
      ),
    ).toBe("JOURNAL_RECOVERY_INVALID");

    // A fresh pair is rebased at the server's head.
    const issued = await renew(c);
    expect(issued.snapshot.payload).toMatchObject({
      includedThroughSequence: 3,
      includedThroughHash: head.hash,
    });
    const events = await prisma.auditEvent.findMany({
      where: { tenantId: c.fx.tenantId, entityId: reported.recoveryId },
      orderBy: { createdAt: "asc" },
      select: { eventName: true },
    });
    expect(events.map((e) => e.eventName)).toEqual([
      "terminal.journal_recovery_reported",
      "terminal.journal_recovery_approved",
      "terminal.journal_recovery_completed",
    ]);
  });

  it("keeps a forked computer's unmatched sales as paged evidence, never as sales", async () => {
    const c = await counter({ main: 40 });
    const { head, open, backup, signIn } = await acceptedJournal(c);
    const stockBefore = await onHand(c.batches.main);
    const salesBefore = await prisma.sale.count({
      where: { tenantId: c.fx.tenantId },
    });

    // Restored at the shift open, the computer sold three more times before it reconnected.
    const forkA = backup.sale(signIn, [[c.batches.main, 4]]);
    const forkB = backup.sale(signIn, [[c.batches.main, 1]]);
    const forkC = backup.sale(signIn, [[c.batches.main, 2]]);
    const report = signedReport(c, {
      serverHead: head,
      commonPrefix: position(open),
      localHead: position(forkC),
    });

    // Pages continue from the last entry received; a gap or another chain is refused.
    expect(await code(upload(c, report, [forkB], [signIn]))).toBe(
      "JOURNAL_RECOVERY_INVALID",
    );
    const first = await upload(c, report, [forkA, forkB], [signIn]);
    expect(first).toMatchObject({ unmatched: 3, received: 2 });
    expect((await upload(c, report, [forkA, forkB])).received).toBe(2);
    const id = first.recoveryId;
    const approve = {
      reason:
        "Counted the batch; 7 units and their cash recorded by adjustment.",
      expectedServerHeadSequence: 3,
      expectedUnmatched: 3,
    };
    expect(
      await code(recovery.approve(c.owner, c.fx.mainBranchId, id, approve)),
    ).toBe("JOURNAL_RECOVERY_EVIDENCE_INCOMPLETE");
    expect((await upload(c, report, [forkC])).received).toBe(3);

    const detail = await recovery.detail(c.owner, c.fx.mainBranchId, id);
    expect(detail).toMatchObject({
      kind: "counter_restore",
      restoredEntries: 2,
      localHead: position(forkC),
      stale: false,
    });
    expect(
      detail.unmatched.map((u) => [
        u.sequence,
        u.kind,
        u.totalMinor,
        u.staffUserId,
      ]),
    ).toEqual([
      [2, "ordinary_sale", forkA.payload.totalMinor, c.cashier.userId],
      [3, "ordinary_sale", forkB.payload.totalMinor, c.cashier.userId],
      [4, "ordinary_sale", forkC.payload.totalMinor, c.cashier.userId],
    ]);
    expect(
      await code(
        recovery.approve(c.owner, c.fx.mainBranchId, id, {
          ...approve,
          expectedUnmatched: 2,
        }),
      ),
    ).toBe("JOURNAL_RECOVERY_STALE");
    await expect(
      recovery.approve(c.owner, c.fx.mainBranchId, id, approve),
    ).resolves.toMatchObject({ status: "approved" });

    // Evidence only: no sale, no stock movement, and the rows cannot be changed.
    expect(
      await prisma.sale.count({ where: { tenantId: c.fx.tenantId } }),
    ).toBe(salesBefore);
    expect(await onHand(c.batches.main)).toBe(stockBefore);
    await expect(
      prisma.offlineJournalRecoveryEntry.deleteMany({
        where: { recoveryId: id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.offlineJournalRecovery.update({
        where: { id },
        data: { approvalReason: "edited" },
      }),
    ).rejects.toThrow();
  });

  it("refuses reports that do not match the server, and supersedes one the journal moved past", async () => {
    const c = await counter({ main: 40 });
    const { head, open, saleA, j, signIn } = await acceptedJournal(c);

    expect(
      await code(
        upload(
          c,
          signedReport(c, {
            serverHead: position(saleA),
            commonPrefix: position(open),
            localHead: position(open),
          }),
        ),
      ),
    ).toBe("JOURNAL_RECOVERY_STALE");
    const notShared = { sequence: 1, hash: "e".repeat(64) };
    expect(
      await code(
        upload(
          c,
          signedReport(c, {
            serverHead: head,
            commonPrefix: notShared,
            localHead: notShared,
          }),
        ),
      ),
    ).toBe("JOURNAL_RECOVERY_INVALID");
    // A computer that has the whole server chain is behind, not different.
    const ahead = j.fork().sale(signIn, [[c.batches.main, 1]]);
    expect(
      await code(
        upload(
          c,
          signedReport(c, {
            serverHead: head,
            commonPrefix: head,
            localHead: position(ahead),
          }),
          [ahead],
        ),
      ),
    ).toBe("JOURNAL_RECOVERY_NOT_NEEDED");
    // An accepted entry is not unmatched.
    const lying = signedReport(c, {
      serverHead: head,
      commonPrefix: position(open),
      localHead: position(saleA),
    });
    expect(await code(upload(c, lying, [saleA]))).toBe(
      "JOURNAL_RECOVERY_INVALID",
    );
    // Another computer's signature is refused outright.
    const stranger = terminalDevice().sign(
      signedReport(c, {
        serverHead: head,
        commonPrefix: position(open),
        localHead: position(open),
      }).payload,
      c.identity.keyId,
    );
    expect(await code(upload(c, stranger))).toBe("INVALID_SIGNATURE");

    const first = await upload(
      c,
      signedReport(c, {
        serverHead: head,
        commonPrefix: position(open),
        localHead: position(open),
      }),
    );
    // The original computer is still alive and uploads another sale: the report no longer holds.
    const later = j.sale(signIn, [[c.batches.main, 1]]);
    expect(
      (await sync(c, { commands: [later] })).payload.committedThroughSequence,
    ).toBe(4);
    const view = await recovery.list(c.owner, c.fx.mainBranchId);
    expect(
      view.recoveries.find((r) => r.recoveryId === first.recoveryId)?.stale,
    ).toBe(true);
    expect(
      await code(
        recovery.approve(c.owner, c.fx.mainBranchId, first.recoveryId, {
          reason: "Looks fine",
          expectedServerHeadSequence: 3,
          expectedUnmatched: 0,
        }),
      ),
    ).toBe("JOURNAL_RECOVERY_STALE");
    expect(
      (
        await recovery.status(c.cashier, c.fx.mainBranchId, {
          identity: c.identity,
        })
      )?.status,
    ).toBe("superseded");

    // Reporting again opens a new recovery; only one is ever open per counter.
    const again = await upload(
      c,
      signedReport(c, {
        serverHead: position(later),
        commonPrefix: position(open),
        localHead: position(open),
      }),
    );
    expect(again.status).toBe("awaiting_approval");
    expect(
      await prisma.offlineJournalRecovery.count({
        where: {
          tenantId: c.fx.tenantId,
          enrollmentId: c.identity.enrollmentId,
          status: { in: ["awaiting_approval", "approved"] },
        },
      }),
    ).toBe(1);

    // Approved, but the journal moves again before the counter applies it: completion is refused
    // and the recovery stays superseded, so the counter reports once more.
    await recovery.approve(c.owner, c.fx.mainBranchId, again.recoveryId, {
      reason: "Nothing sold on the restored computer",
      expectedServerHeadSequence: 4,
      expectedUnmatched: 0,
    });
    expect(
      (await sync(c, { commands: [j.sale(signIn, [[c.batches.main, 1]])] }))
        .payload.committedThroughSequence,
    ).toBe(5);
    const completion = signedCompletion(
      c,
      again.recoveryId,
      position(later),
      position(open),
    );
    expect(
      await code(
        recovery.complete(c.cashier, c.fx.mainBranchId, again.recoveryId, {
          completion,
        }),
      ),
    ).toBe("JOURNAL_RECOVERY_STALE");
    expect(
      await recovery.status(c.cashier, c.fx.mainBranchId, {
        identity: c.identity,
      }),
    ).toMatchObject({
      recoveryId: again.recoveryId,
      status: "superseded",
    });
    expect(await code(renew(c))).not.toBe("RECONCILIATION_REQUIRED");
  });
});

/** A second enrolled counter at the branch, authorized and ready to activate as the offline counter. */
async function replacement(c: Counter) {
  const { fx, owner, manager } = c;
  const branch = fx.mainBranchId;
  const device = terminalDevice();
  const proof = (
    a: Parameters<typeof attest>[1],
    purpose: Parameters<typeof attest>[2],
    actor = owner,
  ) =>
    proofs.record(
      actor,
      branch,
      device.sign(
        attest(fx, a, purpose, actor),
        a.identity.keyId,
        "attendance",
      ),
    );
  const register = await tx((t) =>
    trust.createCounter(t, owner, branch, "Back"),
  );
  const enrollment = await tx((t) =>
    trust.beginEnrollment(t, owner, branch, {
      registerId: register.id,
      keyId: randomUUID(),
      publicKeyHex: device.publicKeyHex,
      label: "Back PC",
    }),
  );
  const ep = await proof(enrollment, "enrollment");
  const identity = await tx((t) =>
    trust.finishEnrollment(
      t,
      owner,
      branch,
      device.sign(enrollment, enrollment.identity.keyId),
      ep.proofId,
    ),
  );
  const authorizationId = randomUUID();
  await assignments.authorize(owner, branch, {
    authorizationId,
    targetTerminalId: identity.terminalId,
    targetEnrollmentId: identity.enrollmentId,
    expectedNominationVersion: 1,
    reason: "Front counter is broken",
  });
  return async () => {
    const session = await tx((t) =>
      trust.beginSession(t, manager, branch, identity),
    );
    const sp = await proof(session, "session", manager);
    const { workSessionId } = await tx((t) =>
      trust.finishSession(
        t,
        manager,
        branch,
        device.sign(session, identity.keyId),
        sp.proofId,
      ),
    );
    const command = await activation.prepare(manager, branch, {
      workSessionId,
      authorizationId,
      expectedNominationVersion: 1,
    });
    const ap = await proof(command, "command", manager);
    return activation.activate(manager, branch, {
      envelope: device.sign(command, identity.keyId),
      attendanceProofId: ap.proofId,
    });
  };
}

describe("missing-journal sign-off and replacing the offline counter (D11)", () => {
  const clearance = new OfflineActivationClearance();
  const check = (c: Counter, at: number) =>
    tx(async (t) => {
      const previous = await t.offlineTerminalNomination.findFirstOrThrow({
        where: { tenantId: c.fx.tenantId, branchId: c.fx.mainBranchId },
      });
      return clearance.check(t, previous, at);
    });
  const signOff = (
    c: Counter,
    actor: Counter["owner"],
    at: number,
    expectedServerHeadSequence: number,
  ) =>
    recovery.signOffMissingJournal(
      actor,
      c.fx.mainBranchId,
      {
        enrollmentId: c.identity.enrollmentId,
        expectedNominationVersion: 1,
        expectedServerHeadSequence,
        reason:
          "Front PC's disk failed; the server has its journal through its last sync. Counted the branch since.",
      },
      at,
    );

  it("waits out a revoked counter's last grant, then lets the replacement take over", async () => {
    const c = await counter({ main: 40 });
    await acceptedJournal(c);
    const expiry = c.grant.expiresAt;
    const activate = await replacement(c);

    // Still able to sell offline: the replacement waits (P3's half).
    expect(await code(activate())).toBe("D11_CLEARANCE_REQUIRED");
    await tx((t) =>
      trust.revokeEnrollment(
        t,
        c.owner,
        c.fx.mainBranchId,
        c.identity.enrollmentId,
        "Disk failed",
      ),
    );

    // Revoked, but a disconnected device can still sell on its grant: no sign-off before it expires.
    const early = await recovery
      .signOffMissingJournal(
        c.owner,
        c.fx.mainBranchId,
        {
          enrollmentId: c.identity.enrollmentId,
          expectedNominationVersion: 1,
          expectedServerHeadSequence: 3,
          reason: "Too early",
        },
        expiry - 1,
      )
      .catch((e: { response: Record<string, unknown> }) => e.response);
    expect(early).toMatchObject({
      code: "JOURNAL_SIGN_OFF_TOO_EARLY",
      availableAt: expiry,
    });
    await expect(activate()).rejects.toMatchObject({
      response: {
        code: "D11_CLEARANCE_REQUIRED",
        reason: "OFFLINE_RECOVERY_EVIDENCE_REQUIRED",
        journalSignOffAvailableAt: expiry,
      },
    });
    const before = await recovery.list(c.owner, c.fx.mainBranchId);
    expect(before.offlineCounter).toMatchObject({
      revoked: true,
      signOffAvailableAt: expiry,
      journalCleared: false,
      signOff: null,
      serverHead: { sequence: 3 },
    });

    expect(await code(signOff(c, c.owner, expiry, 2))).toBe(
      "JOURNAL_RECOVERY_STALE",
    );
    expect(await code(signOff(c, c.manager, expiry, 3))).toBe(
      "OFFLINE_ASSIGNMENT_NOT_DELEGATED",
    );
    const signed = await signOff(c, c.owner, expiry, 3);
    expect(signed).toMatchObject({
      kind: "missing_journal",
      status: "approved",
      nominationVersion: 1,
      approval: { authority: "owner" },
    });
    expect(
      (await recovery.list(c.owner, c.fx.mainBranchId)).offlineCounter,
    ).toMatchObject({ journalCleared: true });

    const result = await activate();
    expect(result.nominationVersion).toBe(2);
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        tenantId: c.fx.tenantId,
        eventName: "terminal.offline_activated",
        entityId: result.enrollmentId,
      },
    });
    expect(event.payload).toMatchObject({
      clearance: "recovery_evidence",
      journalSignOffId: signed.recoveryId,
    });
  });

  it("goes stale when more journal arrives, or the old counter is issued another grant", async () => {
    const c = await counter({ main: 40 });
    const { j, signIn } = await acceptedJournal(c);
    const expiry = c.grant.expiresAt;
    await assignments.delegate(c.owner, c.fx.mainBranchId, c.manager.userId);

    const first = await signOff(c, c.manager, expiry + 1, 3);
    expect(first.approval?.authority).toBe("delegated_manager");
    await expect(check(c, expiry + 2)).resolves.toMatchObject({
      cleared: true,
      journalSignOffId: first.recoveryId,
    });

    // The counter comes back and uploads a sale it made before its grant expired.
    expect(
      (await sync(c, { commands: [j.sale(signIn, [[c.batches.main, 1]])] }))
        .payload.committedThroughSequence,
    ).toBe(4);
    await expect(check(c, expiry + 2)).resolves.toMatchObject({
      cleared: false,
      reason: "OFFLINE_RECOVERY_EVIDENCE_REQUIRED",
    });
    expect(
      (await recovery.detail(c.owner, c.fx.mainBranchId, first.recoveryId))
        .stale,
    ).toBe(true);

    // Signed off again over the longer journal; the first is superseded.
    const second = await signOff(c, c.owner, expiry + 1, 4);
    expect(
      (await recovery.detail(c.owner, c.fx.mainBranchId, first.recoveryId))
        .status,
    ).toBe("superseded");
    await expect(check(c, expiry + 2)).resolves.toMatchObject({
      cleared: true,
      journalSignOffId: second.recoveryId,
    });

    // A renewal issued after the sign-off extends the old counter's authority: sign off again.
    const renewed = await renew(c);
    await expect(
      check(c, renewed.grant.payload.expiresAt),
    ).resolves.toMatchObject({
      cleared: false,
      reason: "OFFLINE_RECOVERY_EVIDENCE_REQUIRED",
    });
  });
});
