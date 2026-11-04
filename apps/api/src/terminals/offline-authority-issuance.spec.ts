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
    offlineTerminalNomination: { findFirst: jest.fn().mockResolvedValue({ id: "nomination" }) },
    offlineAuthorityIssuance: { findUnique: jest.fn().mockResolvedValue({ snapshotId: "snapshot", grant }) },
    offlineStockSnapshot: { findFirstOrThrow: jest.fn().mockResolvedValue({ envelope: snapshot }) },
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

  tx.offlineAuthorityIssuance.findUnique.mockClear();
  authenticate.mockRejectedValueOnce(new Error("Device authentication expired"));
  await expect(run()).rejects.toThrow("Device authentication expired");
  expect(tx.offlineAuthorityIssuance.findUnique).not.toHaveBeenCalled();
});
