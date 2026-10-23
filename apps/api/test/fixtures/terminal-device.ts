import { generateKeyPairSync, sign } from "node:crypto";
import { terminalSigningText, type Signed } from "@pharmaceylon/shared";

/** Real Ed25519 API device fixture. Private key lives only in the test process. */
export function terminalDevice() {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyHex = (
    keys.publicKey.export({ format: "der", type: "spki" }) as Buffer
  )
    .subarray(-32)
    .toString("hex");
  return {
    publicKeyHex,
    sign<T>(
      payload: T,
      keyId: string,
      purpose: Parameters<typeof terminalSigningText>[0] = "command",
    ): Signed<T> {
      return {
        algorithm: "Ed25519",
        keyId,
        payload,
        signature: sign(
          null,
          Buffer.from(terminalSigningText(purpose, payload)),
          keys.privateKey,
        ).toString("base64url"),
      };
    },
  };
}
