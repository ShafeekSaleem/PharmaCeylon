import type { Migration } from "../migrator";
import { foundation } from "./0001-foundation";
import { deviceIdentity } from "./0002-device-identity";
import { staffCredentials } from "./0003-staff-credentials";
import { checkoutDrafts } from "./0004-checkout-drafts";
import { signedCommands } from "./0005-signed-commands";
import { checkoutCoSigner } from "./0006-checkout-co-signer";
import { checkoutDraftCounter } from "./0007-checkout-draft-counter";
import { pinLockUptime } from "./0008-pin-lock-uptime";
import { staffCredentialRole } from "./0009-staff-credential-role";
import { checkoutDiscountCoSigner } from "./0010-checkout-discount-co-signer";

/** Append only. A released migration is never edited or reordered. */
export const migrations: readonly Migration[] = [foundation, deviceIdentity, staffCredentials, checkoutDrafts, signedCommands, checkoutCoSigner, checkoutDraftCounter, pinLockUptime, staffCredentialRole, checkoutDiscountCoSigner];
