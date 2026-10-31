import type { Migration } from "../migrator";
import { foundation } from "./0001-foundation";
import { deviceIdentity } from "./0002-device-identity";
import { staffCredentials } from "./0003-staff-credentials";

/** Append only. A released migration is never edited or reordered. */
export const migrations: readonly Migration[] = [foundation, deviceIdentity, staffCredentials];
