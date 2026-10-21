const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../dist/terminal-contracts.js');
const fixtures = require('./terminal-fixtures.cjs');
const fresh = () => structuredClone(fixtures);
const check = (f, state = 'offline') => c.offlineSalePolicyError(f.grant, f.snapshot, f.sale, f.usage, f.sale.occurredAt, state, f.staffSignIn, f.openShift);
function shiftCommand(f, kind, fields = {}) {
  return {
    contractVersion: 1, kind, commandId: `command-${kind}`, identity: f.sale.identity,
    session: f.sale.session, staffSignInId: f.sale.staffSignInId,
    businessHoursAcknowledgementId: null, assistance: null, sequence: 2, previousCommandHash: 'a'.repeat(64), occurredAt: f.sale.occurredAt,
    grantId: f.grant.grantId, grantVersion: f.grant.grantVersion, nominationVersion: f.grant.nominationVersion,
    offlineSessionId: f.sale.offlineSessionId, offlineStartedAt: f.sale.offlineStartedAt,
    currency: 'LKR', ...fields,
  };
}
const shiftState = f => ({ openShift: f.openShift, expectedCashMinor: f.openShift.openingCashMinor,
  lastClosedWorkSessionId: null, usedWorkSessionIds: [f.openShift.session.workSessionId] });

test('signature encoding is stable across key order and rejects ambiguous numeric/JSON values', () => {
  assert.equal(c.terminalSigningText('command', { z: [true, null], a: 42 }),
    'PharmaCeylon:terminal:v1:command\n{"a":42,"z":[true,null]}');
  assert.equal(c.terminalSigningText('command', { b: 2, a: 1 }), c.terminalSigningText('command', { a: 1, b: 2 }));
  for (const value of [undefined, NaN, Infinity, 0.1, -0, Number.MAX_SAFE_INTEGER + 1,
    new Date(), { a: undefined }, new Array(1)]) assert.throws(() => c.terminalSigningText('command', value));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => c.terminalSigningText('command', cyclic));
});

test('signed fixture round-trip binds payload and signature purpose', () => {
  const { generateKeyPairSync, sign, verify, createHash } = require('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { sale } = fresh();
  const bytes = Buffer.from(c.terminalSigningText('command', sale), 'utf8');
  const envelope = { algorithm: 'Ed25519', keyId: sale.identity.keyId, payload: sale,
    signature: sign(null, bytes, privateKey).toString('base64url') };
  assert.equal(verify(null, bytes, publicKey, Buffer.from(envelope.signature, 'base64url')), true);
  assert.match(createHash('sha256').update(bytes).digest('hex'), /^[a-f0-9]{64}$/);
  const tampered = Buffer.from(c.terminalSigningText('command', { ...sale, totalMinor: 1 }));
  assert.equal(verify(null, tampered, publicKey, Buffer.from(envelope.signature, 'base64url')), false);
  assert.equal(verify(null, Buffer.from(c.terminalSigningText('grant', sale)), publicKey, Buffer.from(envelope.signature, 'base64url')), false);
});

test('partial outage: reachable API without authenticated sync does not restore online operation', () => {
  for (const probe of [
    { apiReachable: false, authenticated: false, syncComplete: false },
    { apiReachable: true, authenticated: false, syncComplete: false },
    { apiReachable: true, authenticated: true, syncComplete: false },
  ]) assert.equal(c.terminalConnectivity(probe), 'partial_outage');
  assert.equal(c.terminalConnectivity({ apiReachable: true, authenticated: true, syncComplete: true }), 'online');
  assert.equal(check(fresh()), null);
  assert.equal(check(fresh(), 'nominated'), 'ONLINE_REQUIRED');
});

test('expiry: stop exactly at the exclusive boundary and retain unsynced sales', () => {
  const f = fresh();
  const day = 24 * 60 * 60 * 1000;
  assert.equal(c.MAX_OFFLINE_GRANT_MS, day);
  assert.equal(f.grant.expiresAt - f.grant.issuedAt, day);
  f.grant.operatingWindows = [{ startsAt: f.grant.notBefore, endsAt: f.grant.expiresAt }];
  f.sale.occurredAt = f.grant.expiresAt - 1;
  assert.equal(check(f), null);
  f.sale.occurredAt = f.grant.expiresAt;
  assert.equal(check(f), 'GRANT_EXPIRED');
  assert.equal(c.nextOfflineTerminalState('offline', 'grant_expired'), 'draining');
  f.grant.expiresAt++;
  assert.throws(() => c.assertOfflineGrantBounds(f.grant), /lifetime/);
});

test('replay: same digest returns original receipt, changed payload or enrollment conflicts', () => {
  const { receipt } = fresh();
  assert.equal(c.classifyCommandReplay(null, receipt), 'new');
  assert.equal(c.classifyCommandReplay(receipt, receipt), 'duplicate');
  assert.equal(c.classifyCommandReplay(receipt, { ...receipt, commandHash: 'b'.repeat(64) }), 'conflict');
  assert.equal(c.classifyCommandReplay(receipt, { ...receipt, sequence: 2 }), 'conflict');
  assert.equal(c.classifyCommandReplay(receipt, { ...receipt, identity: { ...receipt.identity, branchId: 'other' } }), 'conflict');
});

test('crash after server commit: retry resolves to persisted sale rather than another stock issue', () => {
  const { receipt } = fresh();
  // Simulate the durable receipt surviving while the first network response is lost.
  const persisted = JSON.parse(JSON.stringify(receipt));
  const result = c.classifyCommandReplay(persisted, receipt);
  assert.equal(result, 'duplicate');
  const ack = { commandId: persisted.commandId, commandHash: persisted.commandHash,
    sequence: persisted.sequence, status: result, saleId: persisted.saleId, committedAt: persisted.committedAt };
  assert.equal(ack.saleId, 'sale-1');
});

test('replacement: no offline nomination/reactivation or overlapping usable grants', () => {
  assert.throws(() => c.nextOfflineTerminalState('nominated', 'connection_lost'));
  assert.throws(() => c.nextOfflineTerminalState('revoked', 'refresh_online'));
  assert.equal(c.mayEnableOfflineReplacement({ oldGrantCanNoLongerSell: false, oldJournalResolvedOrLossReviewed: true }), false);
  const f = fresh();
  f.sale.identity = { ...f.sale.identity, enrollmentId: 'replacement' };
  assert.equal(check(f), 'IDENTITY_MISMATCH');
});

test('lost terminal: fence old grant and review missing journal before offline replacement', () => {
  assert.equal(c.nextOfflineTerminalState('offline', 'lost'), 'revoked');
  assert.equal(check(fresh(), 'revoked'), 'TERMINAL_REVOKED');
  for (const oldJournalResolvedOrLossReviewed of [false, true]) for (const oldGrantCanNoLongerSell of [false, true]) {
    assert.equal(c.mayEnableOfflineReplacement({ oldJournalResolvedOrLossReviewed, oldGrantCanNoLongerSell }), oldJournalResolvedOrLossReviewed && oldGrantCanNoLongerSell);
  }
});

test('automatic readiness and reconnect: drain journal before installing a fresh snapshot', () => {
  let state = c.nextOfflineTerminalState('nominated', 'refresh_online');
  assert.equal(state, 'ready');
  assert.equal(c.nextOfflineTerminalState(state, 'refresh_online'), 'ready');
  state = c.nextOfflineTerminalState(state, 'connection_lost');
  state = c.nextOfflineTerminalState(state, 'connection_restored');
  assert.equal(state, 'draining');
  assert.equal(check(fresh(), state), 'ONLINE_REQUIRED');
  assert.throws(() => c.nextOfflineTerminalState(state, 'refresh_online'));
  assert.throws(() => c.nextOfflineTerminalState(state, 'connection_lost'));
  assert.equal(c.nextOfflineTerminalState(state, 'reconciled_online'), 'nominated');
});

test('approved resume workflow: incomplete sync stays paused; installed review blocks permit other stock', () => {
  const complete = { authenticated: true, journalAcceptedThroughLastLocalCommand: true,
    uncertainCommandsResolved: true, freshSnapshotInstalled: true, stockReviewBlocksInstalled: true, supportRecordsAccepted: true, paymentAttemptsResolved: true };
  assert.equal(c.mayResumeOnlineCheckout(complete), true);
  for (const missing of Object.keys(complete)) {
    assert.equal(c.mayResumeOnlineCheckout({ ...complete, [missing]: false }), false, missing);
  }
  // No requirement to resolve every manager-review case: installing its batch blocks is sufficient.
  const f = fresh();
  f.snapshot.lines[0].stockReviewRequired = true;
  assert.equal(c.mayResumeOnlineCheckout(complete), true);
  assert.equal(check(f), 'RECONCILIATION_REQUIRED');
});

test('snapshot quantities are local limits, not centrally reserved stock', () => {
  const f = fresh();
  f.usage.quantities['line-1'] = 19;
  assert.equal(check(f), 'LOCAL_STOCK_EXHAUSTED');
  f.usage.quantities['line-1'] = 18;
  assert.equal(check(f), null);
  f.sale.lines[0].snapshotLineId = 'unknown';
  assert.equal(check(f), 'SNAPSHOT_MISMATCH');
});

test('approved D9: sale count and value have no additional offline business caps', () => {
  const f = fresh();
  // Greater than both former fixture amount caps; a large journal sequence is not a sale-count limit.
  f.snapshot.lines[0].availableQuantity = 100;
  f.usage.quantities['line-1'] = 40;
  f.sale.sequence = 1001;
  f.sale.previousCommandHash = 'a'.repeat(64);
  f.sale.lines[0].quantity = 60;
  f.sale.lines[0].taxMinor = 10800;
  f.sale.totalMinor = 70800;
  f.sale.payments = [{ method: 'cash', amountMinor: 70800, tenderedMinor: 70800, changeMinor: 0 }];
  assert.equal(check(f), null);
  f.usage.quantities['line-1']++;
  assert.equal(check(f), 'LOCAL_STOCK_EXHAUSTED');
});

test('integer money, quantity, exact tax, no duplicate lines or offline price overrides', () => {
  for (const mutate of [
    f => { f.sale.lines[0].quantity = 0.5; },
    f => { f.sale.lines[0].quantity = Number.MAX_SAFE_INTEGER + 1; },
    f => { f.sale.lines[0].taxMinor = 359; },
    f => { f.sale.lines[0].unitPriceMinor++; },
    f => { f.sale.lines[0].discountMinor = 1; },
    f => { f.sale.lines.push({ ...f.sale.lines[0] }); },
    f => { f.sale.totalMinor++; },
    f => { f.sale.payments[0].changeMinor++; },
    f => { f.sale.previousCommandHash = 'unexpected'; },
  ]) {
    const f = fresh(); mutate(f); assert.equal(check(f), 'INVALID_COMMAND');
  }
});

test('external card requires grant permission and independent approval reference', () => {
  const f = fresh();
  f.sale.payments = [{ method: 'external_card', amountMinor: 2360, providerReference: 'acquirer-1', approvalCode: 'approved-1', approvedAt: f.sale.occurredAt }];
  assert.equal(check(f), 'PAYMENT_NOT_ALLOWED');
  f.grant.externalCardAllowed = true;
  assert.equal(check(f), null);
  f.sale.payments[0].approvalCode = '';
  assert.equal(check(f), 'PAYMENT_NOT_ALLOWED');
});

test('approved payments: cash/card split tender must cover the sale exactly', () => {
  const f = fresh();
  f.grant.externalCardAllowed = true;
  f.sale.payments = [
    { method: 'cash', amountMinor: 1000, tenderedMinor: 1500, changeMinor: 500 },
    { method: 'external_card', amountMinor: 1360, providerReference: 'acquirer-1', approvalCode: 'approved-1', approvedAt: f.sale.occurredAt },
  ];
  assert.equal(check(f), null);
  f.sale.payments[1].amountMinor--;
  assert.equal(check(f), 'INVALID_COMMAND');
});

test('approved payments: mobile wallets and customer credit require internet', () => {
  for (const method of ['mobile_wallet', 'credit']) {
    const f = fresh();
    f.sale.payments = [{ method, amountMinor: f.sale.totalMinor }];
    assert.equal(check(f), 'PAYMENT_NOT_ALLOWED');
  }
});

test('saved business extension needs evidence; expired batch still cannot be sold', () => {
  const f = fresh();
  f.sale.occurredAt = f.grant.operatingWindows[0].endsAt;
  assert.equal(check(f), 'BUSINESS_HOURS_ACK_REQUIRED');
  f.grant.operatingHoursException = { approvalId: 'approval-1', approverUserId: 'manager-1', reason: 'Extended local opening', startsAt: f.sale.occurredAt, endsAt: f.sale.occurredAt + 3600000 };
  assert.equal(check(f), null);
  f.snapshot.lines[0].sellBefore = f.sale.occurredAt;
  assert.equal(check(f), 'ONLINE_REQUIRED');
});

test('grant/session versions and trusted time are binding', () => {
  const f = fresh();
  assert.equal(c.offlineSalePolicyError(f.grant, f.snapshot, f.sale, f.usage, f.sale.occurredAt - 1, 'offline', f.staffSignIn, f.openShift), 'CLOCK_UNTRUSTED');
  f.sale.session = { ...f.sale.session, staffUserId: 'other-staff' };
  assert.equal(check(f), 'SESSION_INVALID');
  f.sale.session = f.openShift.session;
  f.sale.snapshotVersion++;
  assert.equal(check(f), 'SNAPSHOT_MISMATCH');
});

test('snapshot freshness is measured at outage start, not repeatedly during the outage', () => {
  const f = fresh();
  assert.equal(c.MAX_SNAPSHOT_AGE_AT_OUTAGE_MS, 15 * 60 * 1000);
  assert.equal(f.grant.maxSnapshotAgeAtOutageMs, c.MAX_SNAPSHOT_AGE_AT_OUTAGE_MS);
  f.sale.offlineStartedAt = f.snapshot.generatedAt + f.grant.maxSnapshotAgeAtOutageMs + 1;
  f.usage.offlineStartedAt = f.sale.offlineStartedAt;
  f.sale.occurredAt = f.sale.offlineStartedAt;
  assert.equal(check(f), 'SNAPSHOT_STALE');
  f.sale.offlineStartedAt--;
  f.usage.offlineStartedAt--;
  assert.equal(check(f), null);
  f.sale.occurredAt += 3600000;
  assert.equal(check(f), null);
  f.grant.maxSnapshotAgeAtOutageMs++;
  assert.throws(() => c.assertOfflineGrantBounds(f.grant), /limits/);
});

test('refresh cannot reset local consumption or let the journal cross snapshot baselines', () => {
  const f = fresh();
  f.usage.snapshotId = 'older-snapshot';
  assert.equal(check(f), 'SNAPSHOT_MISMATCH');
  f.usage.snapshotId = f.snapshot.snapshotId;
  f.snapshot.includedThroughSequence = f.sale.sequence;
  f.snapshot.includedThroughHash = 'a'.repeat(64);
  assert.equal(check(f), 'INVALID_COMMAND');
});

test('zero/empty snapshot balances never authorize untracked offline stock', () => {
  const f = fresh();
  f.snapshot.lines[0].availableQuantity = 0;
  assert.equal(check(f), 'LOCAL_STOCK_EXHAUSTED');
  f.snapshot.lines = [];
  assert.equal(check(f), 'SNAPSHOT_MISMATCH');
});

test('snapshot signature has its own domain and is bound to enrollment', () => {
  const f = fresh();
  assert.notEqual(c.terminalSigningText('snapshot', f.snapshot), c.terminalSigningText('grant', f.snapshot));
  f.snapshot.identity = { ...f.snapshot.identity, enrollmentId: 'other-device' };
  assert.equal(check(f), 'IDENTITY_MISMATCH');
});

test('stock conflict receipt survives retries without erasing or duplicating a completed sale', () => {
  const { receipt } = fresh();
  const conflictReceipt = { ...receipt, stockPosting: 'pending_reconciliation', reconciliationCaseId: 'case-1' };
  const persisted = JSON.parse(JSON.stringify(conflictReceipt));
  assert.equal(c.classifyCommandReplay(persisted, receipt), 'duplicate');
  assert.equal(persisted.saleId, receipt.saleId);
  assert.equal(persisted.reconciliationCaseId, 'case-1');
});

test('approved conflict policy: a refreshed snapshot cannot resell batches awaiting stock review', () => {
  const f = fresh();
  f.snapshot.lines[0].stockReviewRequired = true;
  assert.equal(check(f), 'RECONCILIATION_REQUIRED');
});

test('staff switching: a second authorized session can sell without resetting terminal stock', () => {
  const f = fresh();
  const secondStaff = { ...f.grant.authorizedStaff[0], staffUserId: 'staff-2', staffAuthorizationId: 'staff-auth-2' };
  const second = { ...f.sale.session, staffUserId: secondStaff.staffUserId, workSessionId: 'session-2' };
  f.grant.authorizedStaff.push(secondStaff);
  f.sale.session = second;
  f.sale.staffSignInId = 'sign-in-2';
  f.staffSignIn = { ...f.staffSignIn, staffSignInId: f.sale.staffSignInId, session: second, staffAuthorizationId: secondStaff.staffAuthorizationId };
  f.openShift = { ...f.openShift, session: second };
  assert.equal(check(f), null);
  f.usage.quantities['line-1'] = 19;
  assert.equal(check(f), 'LOCAL_STOCK_EXHAUSTED');
});

test('staff authorization: changing the user or till is not a verified staff switch', () => {
  const f = fresh();
  f.sale.session = { ...f.sale.session, tillId: 'another-till' };
  assert.equal(check(f), 'SESSION_INVALID');
  f.grant.authorizedStaff.push({ ...f.grant.authorizedStaff[0], staffUserId: 'staff-2' });
  assert.throws(() => c.assertOfflineGrantBounds(f.grant), /staff/);
});

test('approved offline sign-in: prepared staff need matching PIN verification evidence', () => {
  for (const mutate of [
    f => { f.sale.staffSignInId = ''; },
    f => { f.staffSignIn.staffAuthorizationId = 'unknown'; },
    f => { f.staffSignIn.credentialVersion++; },
    f => { f.staffSignIn.method = 'claimed_user_id'; },
    f => { f.staffSignIn.session = { ...f.staffSignIn.session, staffUserId: 'someone-else' }; },
    f => { f.staffSignIn.identity = { ...f.staffSignIn.identity, branchId: 'another-branch' }; },
    f => { f.staffSignIn.authenticatedAt = f.sale.occurredAt + 1; },
  ]) {
    const f = fresh(); mutate(f); assert.equal(check(f), 'SESSION_INVALID');
  }
});

test('approved shift handover: count cash, close, then open a distinct shift on the same till', () => {
  const f = fresh();
  const usageBefore = structuredClone(f.usage);
  const close = shiftCommand(f, 'shift_close', { closingCashCountMinor: 9900, expectedCashMinor: 10000 });
  const closed = c.offlineShiftTransition(f.grant, close, shiftState(f), f.staffSignIn, close.occurredAt, 'offline');
  assert.equal(closed.error, null);
  assert.equal(closed.next.openShift, null);
  assert.equal(closed.closingSummary.varianceMinor, -100);
  assert.equal(closed.closingSummary.syncStatus, 'pending');
  f.openShift = closed.next.openShift;
  assert.equal(check(f), 'SESSION_INVALID');

  const staff = { ...f.grant.authorizedStaff[0], staffUserId: 'staff-2', staffAuthorizationId: 'staff-auth-2' };
  f.grant.authorizedStaff.push(staff);
  f.sale.session = { ...f.sale.session, staffUserId: staff.staffUserId, workSessionId: 'offline-created-shift-2' };
  f.sale.staffSignInId = 'sign-in-2';
  f.staffSignIn = { ...f.staffSignIn, staffSignInId: f.sale.staffSignInId, session: f.sale.session, staffAuthorizationId: staff.staffAuthorizationId };
  const open = shiftCommand(f, 'shift_open', { sequence: 3, openingCashMinor: 9900,
    previousClosedWorkSessionId: closed.next.lastClosedWorkSessionId });
  const opened = c.offlineShiftTransition(f.grant, open, closed.next, f.staffSignIn, open.occurredAt, 'offline');
  assert.equal(opened.error, null);
  assert.equal(opened.next.expectedCashMinor, 9900);
  assert.equal(opened.next.openShift.session.workSessionId, 'offline-created-shift-2');
  f.openShift = opened.next.openShift;
  f.sale.sequence = 4;
  f.sale.previousCommandHash = 'b'.repeat(64);
  assert.equal(check(f), null);
  assert.deepEqual(f.usage, usageBefore);
  f.sale.occurredAt = f.grant.expiresAt;
  assert.equal(check(f), 'GRANT_EXPIRED');
});

test('shift lifecycle refuses overlapping shifts, reused shift IDs and altered expected cash', () => {
  const f = fresh();
  const current = shiftState(f);
  const open = shiftCommand(f, 'shift_open', { openingCashMinor: 10000, previousClosedWorkSessionId: null });
  assert.equal(c.offlineShiftTransition(f.grant, open, current, f.staffSignIn, open.occurredAt, 'offline').error, 'SESSION_INVALID');
  const close = shiftCommand(f, 'shift_close', { closingCashCountMinor: 10000, expectedCashMinor: 1 });
  assert.equal(c.offlineShiftTransition(f.grant, close, current, f.staffSignIn, close.occurredAt, 'offline').error, 'INVALID_COMMAND');
  close.expectedCashMinor = 10000;
  const closed = c.offlineShiftTransition(f.grant, close, current, f.staffSignIn, close.occurredAt, 'offline');
  open.previousClosedWorkSessionId = close.session.workSessionId;
  assert.equal(c.offlineShiftTransition(f.grant, open, closed.next, f.staffSignIn, open.occurredAt, 'offline').error, 'SESSION_INVALID');
  assert.equal(c.offlineShiftTransition(f.grant, close, closed.next, f.staffSignIn, close.occurredAt, 'offline').error, 'SESSION_INVALID');
});

test('shift commands use the same durable replay identity as sales', () => {
  const f = fresh();
  const close = shiftCommand(f, 'shift_close', { closingCashCountMinor: 10000, expectedCashMinor: 10000 });
  const { createHash } = require('node:crypto');
  const receipt = { identity: close.identity, commandKind: close.kind, commandId: close.commandId,
    commandHash: createHash('sha256').update(c.terminalSigningText('command', close)).digest('hex'),
    sequence: close.sequence, workSessionId: close.session.workSessionId, committedAt: close.occurredAt };
  assert.equal(c.classifyCommandReplay(JSON.parse(JSON.stringify(receipt)), receipt), 'duplicate');
  assert.equal(c.classifyCommandReplay(receipt, { ...receipt, commandHash: 'f'.repeat(64) }), 'conflict');
});

test('approved hours: closing/counting cash after sales hours is allowed without reopening sales', () => {
  const f = fresh();
  f.sale.occurredAt = f.grant.operatingWindows[0].endsAt;
  assert.equal(check(f), 'BUSINESS_HOURS_ACK_REQUIRED');
  const close = shiftCommand(f, 'shift_close', { closingCashCountMinor: 10000, expectedCashMinor: 10000 });
  const closed = c.offlineShiftTransition(f.grant, close, shiftState(f), f.staffSignIn, close.occurredAt, 'offline');
  assert.equal(closed.error, null);
  assert.equal(closed.closingSummary.syncStatus, 'pending');
  const newSession = { ...f.sale.session, workSessionId: 'after-hours-shift' };
  const open = shiftCommand(f, 'shift_open', { session: newSession, openingCashMinor: 10000,
    previousClosedWorkSessionId: close.session.workSessionId });
  const signIn = { ...f.staffSignIn, session: newSession };
  assert.equal(c.offlineShiftTransition(f.grant, open, closed.next, signIn, open.occurredAt, 'offline').error, 'BUSINESS_HOURS_ACK_REQUIRED');
  close.occurredAt = f.grant.expiresAt;
  assert.equal(c.offlineShiftTransition(f.grant, close, shiftState(f), f.staffSignIn, close.occurredAt, 'offline').error, 'GRANT_EXPIRED');
});

test('revised designation authority: owner or delegated manager may authorize remotely online', () => {
  const owner = { online: true, localAttendanceVerified: true, isOwner: true,
    isManagerAtBranch: false, hasActiveOwnerDelegation: false };
  assert.equal(c.mayManageOfflineTerminal(owner), true);
  const manager = { ...owner, isOwner: false, isManagerAtBranch: true };
  assert.equal(c.mayManageOfflineTerminal(manager), false);
  assert.equal(c.mayManageOfflineTerminal({ ...manager, hasActiveOwnerDelegation: true }), true);
  assert.equal(c.mayManageOfflineTerminal({ ...manager, isManagerAtBranch: false, hasActiveOwnerDelegation: true }), false);
  assert.equal(c.mayManageOfflineTerminal({ ...owner, online: false }), false);
  assert.equal(c.mayManageOfflineTerminal({ ...owner, localAttendanceVerified: false }), true);
  assert.equal(c.mayManageOfflineTerminal({ ...manager, hasActiveOwnerDelegation: true, localAttendanceVerified: false }), true);
});

function restartEvidence() {
  const f = fresh();
  const original = { grantId: f.grant.grantId, grantVersion: f.grant.grantVersion,
    grantExpiresAt: f.grant.expiresAt, offlineSessionId: f.sale.offlineSessionId,
    offlineStartedAt: f.sale.offlineStartedAt, snapshotId: f.snapshot.snapshotId, snapshotVersion: f.snapshot.snapshotVersion,
    lastJournalSequence: 1, lastJournalHash: 'a'.repeat(64) };
  return { restartKind: 'app_restart', timeContinuityProof: 'same_boot_monotonic',
    stateBeforeRestart: 'offline', original, restored: structuredClone(original),
    journalIntact: true, stockUsageRestored: true, staffStateRestored: true, shiftStateRestored: true,
    trustedClockRestored: true, timeRollbackDetected: false, trustedNow: f.sale.occurredAt + 1000 };
}

test('approved restart: intact state resumes the same outage without extending expiry or resetting usage', () => {
  const evidence = restartEvidence();
  assert.deepEqual(c.offlineRestartDecision(evidence), { action: 'restore_same_offline_session', reason: null });
  for (const key of Object.keys(evidence.original)) {
    const changed = structuredClone(evidence);
    const value = changed.restored[key];
    changed.restored[key] = typeof value === 'number' ? value + 1 : `changed-${value}`;
    assert.equal(c.offlineRestartDecision(changed).action, 'require_online_recovery', key);
  }
});

test('approved restart: damaged journal, lost state or untrusted clock requires recovery and retains input', () => {
  for (const missing of ['journalIntact', 'stockUsageRestored', 'staffStateRestored', 'shiftStateRestored', 'trustedClockRestored']) {
    const evidence = { ...restartEvidence(), [missing]: false };
    const saved = structuredClone(evidence);
    assert.equal(c.offlineRestartDecision(evidence).action, 'require_online_recovery', missing);
    assert.deepEqual(evidence, saved);
  }
  const evidence = { ...restartEvidence(), timeRollbackDetected: true };
  assert.deepEqual(c.offlineRestartDecision(evidence), { action: 'require_online_recovery', reason: 'CLOCK_UNTRUSTED' });
});

test('restart cannot bypass paused sync, expired permission or revocation', () => {
  const evidence = restartEvidence();
  assert.equal(c.offlineRestartDecision({ ...evidence, stateBeforeRestart: 'draining' }).action, 'keep_sync_paused');
  assert.equal(c.offlineRestartDecision({ ...evidence, trustedNow: evidence.original.grantExpiresAt }).reason, 'GRANT_EXPIRED');
  assert.equal(c.offlineRestartDecision({ ...evidence, stateBeforeRestart: 'revoked' }).reason, 'TERMINAL_REVOKED');
  assert.equal(c.offlineRestartDecision({ ...evidence, stateBeforeRestart: 'nominated' }).action, 'offline_not_permitted');
});
