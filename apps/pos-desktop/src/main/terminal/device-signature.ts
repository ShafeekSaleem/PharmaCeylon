import { createPublicKey, verify } from "node:crypto";
import { terminalSigningText, type Signed } from "@pharmaceylon/shared";

/**
 * Verifies an Ed25519 device signature the same way the API does for terminal commands
 * (`verifySignature` in `apps/api/src/terminals/terminal-wire.ts`): SPKI-wrapped raw public key,
 * message = UTF-8 `terminalSigningText("command", payload)`.
 */
export function verifyDeviceCommandSignature<T>(envelope: Signed<T>, publicKeyHex: string): void {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) throw new Error("INVALID_SIGNATURE");
  const hex = publicKeyHex.toLowerCase();
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  });
  const msg = Buffer.from(terminalSigningText("command", envelope.payload), "utf8");
  if (!verify(null, msg, key, Buffer.from(envelope.signature, "base64url"))) throw new Error("INVALID_SIGNATURE");
}
