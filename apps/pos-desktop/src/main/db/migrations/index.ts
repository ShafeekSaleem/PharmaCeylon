import type { Migration } from "../migrator";
import { foundation } from "./0001-foundation";

/** Append only. A released migration is never edited or reordered. */
export const migrations: readonly Migration[] = [foundation];
