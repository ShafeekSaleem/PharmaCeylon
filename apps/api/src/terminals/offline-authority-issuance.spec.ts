import { generateKeyPairSync } from "node:crypto";
import type { PrismaService } from "../prisma/prisma.service";
import type { AccessService } from "../security/access.service";
import { issueOfflineAuthority } from "./offline-authority-issuance";

it("authenticates before replaying the original pair without recomputing authority", async () => {
  const identity = {
    tenantId: "tenant", branchId: "branch", enrollmentId: "enrollment",
    terminalId: "terminal", keyId: "device-key",
  };
  const grant = { payload: { grantVersion: 3 } };
  const snapshot = { payload: { snapshotVersion: 3 } };
  const tx = {
    // The nomination share lock D11 clearance pairs with.
    $queryRaw: jest.fn().mockResolvedValue([{ id: "nomination" }]),
    offlineTerminalNomination: { findFirst: jest.fn().mockResolvedValue({ id: "nomination" }) },
    offlineAuthorityIssuance: { findUnique: jest.fn().mockResolvedValue({ snapshotId: "snapshot", grant }) },
    offlineStockSnapshot: { findFirstOrThrow: jest.fn().mockResolvedValue({ envelope: snapshot }) },
    // No store restore awaits acknowledgement (P5 #51): a replay is still answered.
    offlineCounterRestore: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const prisma = {
    $transaction: (run: (client: typeof tx) => unknown) => run(tx),
  } as unknown as PrismaService;
  const authenticate = jest.fn().mockResolvedValue({ identity, commandId: "command" });
  const readState = jest.fn();
  const run = () => issueOfflineAuthority(prisma, {} as AccessService, {
    authenticate, readState, defaultVatRatePercent: 0,
    signer: { keyId: "server", privateKey: generateKeyPairSync("ed25519").privateKey },
  });

  await expect(run()).resolves.toEqual({ grant, snapshot });
  expect(authenticate).toHaveBeenCalledWith(tx);
  expect(readState).not.toHaveBeenCalled();

  // While a store restore awaits acknowledgement, not even a replay is answered.
  tx.offlineCounterRestore.findFirst.mockResolvedValueOnce({ id: "restore" });
  await expect(run()).rejects.toMatchObject({ response: { code: "RECONCILIATION_REQUIRED" } });

  tx.offlineAuthorityIssuance.findUnique.mockClear();
  authenticate.mockRejectedValueOnce(new Error("Device authentication expired"));
  await expect(run()).rejects.toThrow("Device authentication expired");
  expect(tx.offlineAuthorityIssuance.findUnique).not.toHaveBeenCalled();
});
