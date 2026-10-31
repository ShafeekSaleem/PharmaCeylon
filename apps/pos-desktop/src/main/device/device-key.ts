import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { terminalSigningText, type Signed } from "@pharmaceylon/shared";

export type SigningPurpose = "command" | "attendance";

/**
 * The counter's Ed25519 identity. The private half lives only in the main process and the
 * encrypted local database (as PKCS#8 DER); it never crosses IPC, logs or the network. The
 * server pins `publicKeyHex` at enrollment and verifies every later signature against it.
 */
export class DeviceKey {
  private constructor(
    private readonly privateKey: KeyObject,
    readonly keyId: string,
    readonly publicKeyHex: string,
  ) {}

  static generate(): DeviceKey {
    const { privateKey } = generateKeyPairSync("ed25519");
    return new DeviceKey(privateKey, randomUUID(), rawPublicKeyHex(privateKey));
  }

  static fromStored(keyId: string, pkcs8: Buffer, expectedPublicKeyHex: string): DeviceKey {
    const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    const publicKeyHex = rawPublicKeyHex(privateKey);
    // A swapped or corrupted blob must not sign as this enrollment.
    if (publicKeyHex !== expectedPublicKeyHex) throw new Error("Stored device key does not match its public key.");
    return new DeviceKey(privateKey, keyId, publicKeyHex);
  }

  /** For the encrypted local store only. */
  exportPkcs8(): Buffer {
    return this.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  }

  /** Signs the payload verbatim, under its purpose, as the server expects. */
  sign<T>(payload: T, purpose: SigningPurpose): Signed<T> {
    return {
      algorithm: "Ed25519",
      keyId: this.keyId,
      payload,
      signature: sign(null, Buffer.from(terminalSigningText(purpose, payload), "utf8"), this.privateKey).toString(
        "base64url",
      ),
    };
  }
}

function rawPublicKeyHex(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(-32).toString("hex");
}
