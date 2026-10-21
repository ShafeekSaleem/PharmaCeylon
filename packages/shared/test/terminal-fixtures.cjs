const issuedAt = Date.UTC(2026, 9, 19, 0);
const identity = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'terminal-1', enrollmentId: 'enrollment-1', keyId: 'device-key-1' };
const session = { registerId: 'register-1', tillId: 'till-1', workSessionId: 'session-1', staffUserId: 'staff-1' };
const authorizedStaff = { staffUserId: session.staffUserId, staffAuthorizationId: 'staff-auth-1', credentialVersion: 1, signInMethod: 'personal_pin', offlineManagerActions: [] };
const grant = {
  contractVersion: 1, kind: 'offline_grant', identity,
  registerId: session.registerId, tillId: session.tillId, authorizedStaff: [authorizedStaff],
  grantId: 'grant-1', grantVersion: 1, nominationVersion: 1,
  issuedAt, notBefore: issuedAt, expiresAt: issuedAt + 24 * 60 * 60 * 1000,
  currency: 'LKR',
  maxSnapshotAgeAtOutageMs: 15 * 60 * 1000, // approved D4
  externalCardAllowed: false, policyVersion: 1,
  operatingWindows: [{ startsAt: issuedAt, endsAt: issuedAt + 8 * 60 * 60 * 1000 }],
  operatingHoursException: null, mandatoryOperatingWindows: null,
};
const snapshot = {
  contractVersion: 1, kind: 'branch_stock_snapshot', identity,
  snapshotId: 'snapshot-1', snapshotVersion: 1, generatedAt: issuedAt,
  includedThroughSequence: 0, includedThroughHash: null,
  lines: [{ snapshotLineId: 'line-1', productId: 'product-1', batchId: 'batch-1', availableQuantity: 20, stockReviewRequired: false,
    unitPriceMinor: 1000, taxBasisPoints: 1800, sellBefore: issuedAt + 96 * 60 * 60 * 1000 }],
};
const sale = {
  contractVersion: 1, kind: 'ordinary_sale', commandId: 'command-1', identity, session,
  staffSignInId: 'sign-in-1', businessHoursAcknowledgementId: null,
  sequence: 1, previousCommandHash: null, occurredAt: issuedAt + 1000,
  grantId: 'grant-1', grantVersion: 1, nominationVersion: 1,
  snapshotId: 'snapshot-1', snapshotVersion: 1, offlineSessionId: 'outage-1', offlineStartedAt: issuedAt + 1000,
  currency: 'LKR', lines: [{ snapshotLineId: 'line-1', quantity: 2, unitPriceMinor: 1000, discountMinor: 0, taxMinor: 360 }],
  payments: [{ method: 'cash', amountMinor: 2360, tenderedMinor: 2500, changeMinor: 140 }], totalMinor: 2360,
};
const receipt = { identity, commandId: sale.commandId, commandHash: 'a'.repeat(64), sequence: 1,
  commandKind: 'ordinary_sale', saleId: 'sale-1', committedAt: issuedAt + 2000, stockPosting: 'posted', reconciliationCaseId: null };
const staffSignIn = { contractVersion: 1, kind: 'offline_staff_sign_in', staffSignInId: sale.staffSignInId,
  identity, session, grantId: grant.grantId, grantVersion: grant.grantVersion,
  staffAuthorizationId: authorizedStaff.staffAuthorizationId, credentialVersion: authorizedStaff.credentialVersion,
  method: 'personal_pin', authenticatedAt: issuedAt };
const openShift = { identity, session, openedAt: issuedAt, openingCashMinor: 10000 };
module.exports = { grant, snapshot, sale, receipt, staffSignIn, openShift, usage: {
  grantId: grant.grantId, grantVersion: grant.grantVersion,
  snapshotId: snapshot.snapshotId, snapshotVersion: snapshot.snapshotVersion,
  offlineSessionId: sale.offlineSessionId, offlineStartedAt: sale.offlineStartedAt,
  quantities: {} } };
