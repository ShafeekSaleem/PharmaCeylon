import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_PHARMACY_APPEARANCE,
  normalizeHex,
  pharmacyBrandCss,
  validatePharmacyAppearance,
  type PharmacyAppearanceSettings,
} from "@pharmaceylon/shared";
import type { CounterBrand } from "../shared/ipc-contract";
import type { CounterThemePolicy } from "./theme";

/**
 * The pharmacy brand on the counter (Epic UI1 #205, decision 4): the owner's accent, status colour
 * set, counter theme default and lock, read from `GET /tenant/appearance` whenever a staff member
 * signs in and every few minutes while one is, and kept in the app's data folder so a counter that
 * restarts offline, or before anyone signs in, still looks like the pharmacy and keeps the lock.
 *
 * Main owns it: it builds the accent stylesheet the renderer draws, tells the theme what the
 * owner decided, and puts the accent on the receipt header.
 */
export type BrandApi = {
  request<T>(method: string, path: string): Promise<T>;
};

type Stored = {
  settings: PharmacyAppearanceSettings;
  version: number;
  fetchedAt: string;
};

export function readCachedBrand(path: string): Stored | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Stored>;
    const checked = validatePharmacyAppearance(raw.settings);
    if (!checked.ok) return null;
    return {
      settings: checked.value,
      version: typeof raw.version === "number" ? raw.version : 0,
      fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : "",
    };
  } catch {
    // Missing or unreadable: the PharmaCeylon defaults, as before brand settings existed.
    return null;
  }
}

function writeCachedBrand(path: string, stored: Stored): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored));
  renameSync(tmp, path);
}

/** The accent for a receipt header: the owner's colour, which always reads on white paper. */
export function receiptAccent(settings: PharmacyAppearanceSettings): string {
  return normalizeHex(settings.accent) ?? DEFAULT_PHARMACY_APPEARANCE.accent;
}

export function counterBrandView(
  settings: PharmacyAppearanceSettings,
): CounterBrand {
  return {
    css:
      settings.accent === DEFAULT_PHARMACY_APPEARANCE.accent
        ? null
        : pharmacyBrandCss(settings.accent),
    statusSet: settings.statusSet,
  };
}

export function createCounterBrand(deps: {
  path: string;
  api: BrandApi;
  /** Whether a staff session is open, so the request has someone to go as. */
  signedIn: () => boolean;
  /** Called after a fetched brand differs from the cached one. */
  onChange?: (settings: PharmacyAppearanceSettings) => void;
  report?: (error: unknown) => void;
}) {
  let stored = readCachedBrand(deps.path);
  let inFlight: Promise<boolean> | null = null;

  const settings = (): PharmacyAppearanceSettings =>
    stored?.settings ?? DEFAULT_PHARMACY_APPEARANCE;

  async function fetchOnce(): Promise<boolean> {
    if (!deps.signedIn()) return false;
    try {
      const raw = await deps.api.request<unknown>("GET", "/tenant/appearance");
      const checked = validatePharmacyAppearance(raw);
      if (!checked.ok) {
        deps.report?.(new Error(`Unusable pharmacy brand: ${checked.error}`));
        return false;
      }
      const version =
        typeof (raw as { version?: unknown }).version === "number"
          ? (raw as { version: number }).version
          : 0;
      const changed =
        JSON.stringify(checked.value) !== JSON.stringify(settings());
      stored = {
        settings: checked.value,
        version,
        fetchedAt: new Date().toISOString(),
      };
      writeCachedBrand(deps.path, stored);
      if (changed) deps.onChange?.(checked.value);
      return changed;
    } catch (error) {
      // Offline or refused: keep drawing the last brand this counter saw.
      deps.report?.(error);
      return false;
    }
  }

  return {
    settings,
    view: (): CounterBrand => counterBrandView(settings()),
    themePolicy: (): CounterThemePolicy => ({
      theme: settings().counterTheme,
      locked: settings().counterThemeLocked,
    }),
    receiptAccent: () => receiptAccent(settings()),
    /** Fetches the brand if someone is signed in. Resolves true when it changed. */
    refresh(): Promise<boolean> {
      inFlight ??= fetchOnce().finally(() => (inFlight = null));
      return inFlight;
    },
  };
}
