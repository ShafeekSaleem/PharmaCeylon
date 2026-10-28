/** W7 settings source. P3 must sign these values; saving does not nominate a device or
 * renew/revoke a disconnected counter's existing permission. Fixed v1 rules are not editable. */
export const COUNTER_OFFLINE_RULES = Object.freeze({
  permissionHours: 24,
  snapshotFreshnessMinutes: 15,
  ordinaryItemsOnly: true,
  discountsAllowed: false,
});

export const COUNTER_POLICY_SCHEMA_VERSION = 2 as const;

/** Cash is always accepted online, so no payment setting can stop a branch selling. These are
 * the other methods a branch may offer at an online counter. Offline payment is fixed: cash,
 * plus external card when the branch allows it. */
export const ONLINE_PAYMENT_METHODS = ["card", "mobile_wallet", "credit"] as const;
export type OnlinePaymentMethod = (typeof ONLINE_PAYMENT_METHODS)[number];
export const ONLINE_PAYMENT_METHOD_LABELS: Readonly<Record<OnlinePaymentMethod, string>> = {
  card: "Card",
  mobile_wallet: "Mobile wallet",
  credit: "Customer credit",
};

/** The series the API numbers online sales with (`INV-YYMM-000123`). Register prefixes may not
 * overlap it, or a counter's number could collide with an online sale's. */
export const ONLINE_INVOICE_PREFIX = "INV-";
export const MAX_REGISTER_PREFIX_LENGTH = 12;
export const MAX_REGISTER_NUMBERING = 50;
export const MAX_EXTERNAL_CARD_MERCHANTS = 20;

export type ExternalCardMerchant = { provider: string; merchantId: string };
/** Number series a register uses for the receipts and invoices it issues. */
export type RegisterNumbering = { registerId: string; receiptPrefix: string; invoicePrefix: string };
export type CounterPolicy = {
  schemaVersion: typeof COUNTER_POLICY_SCHEMA_VERSION;
  onlinePaymentMethods: OnlinePaymentMethod[];
  offlineEnabled: boolean;
  offlineExternalCardEnabled: boolean;
  externalCardMerchants: ExternalCardMerchant[];
  registerNumbering: RegisterNumbering[];
};
/** A register (counter/drawer) at the branch. Retired registers keep their prefixes, so a new
 * register can't reuse a series that already has numbers in it. */
export type CounterRegisterOption = { registerId: string; label: string; isActive: boolean };
export type CounterPolicyView = {
  branchId: string;
  branchName: string;
  version: number;
  policy: CounterPolicy;
  registers: CounterRegisterOption[];
  canEdit: boolean;
};

export function defaultCounterPolicy(): CounterPolicy {
  return {
    schemaVersion: COUNTER_POLICY_SCHEMA_VERSION,
    // Every method the API already accepts online, so an unconfigured branch keeps today's behaviour.
    onlinePaymentMethods: [...ONLINE_PAYMENT_METHODS],
    offlineEnabled: false,
    offlineExternalCardEnabled: false,
    externalCardMerchants: [],
    registerNumbering: [],
  };
}

type Result = { ok: true; value: CounterPolicy } | { ok: false; message: string };
const fail = (message: string) => ({ ok: false as const, message });
const CONTROL = /[\u0000-\u001f\u007f]/;
const PREFIX = /^[A-Z0-9][A-Z0-9-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads a stored document. Version 1 (before online payments and register numbering) upgrades
 * with the defaults those fields would have had; anything else must be a valid version 2.
 */
export function parseStoredCounterPolicy(input: unknown): Result {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const doc = input as Record<string, unknown>;
    if (doc.schemaVersion === 1) {
      const { schemaVersion: _v1, ...rest } = doc;
      const defaults = defaultCounterPolicy();
      return validateCounterPolicy({
        ...rest,
        schemaVersion: COUNTER_POLICY_SCHEMA_VERSION,
        onlinePaymentMethods: defaults.onlinePaymentMethods,
        registerNumbering: defaults.registerNumbering,
      });
    }
  }
  return validateCounterPolicy(input);
}

/** Validates a version 2 document as the editor sends it. Only the register IDs' existence at the
 * branch is left to the server. */
export function validateCounterPolicy(input: unknown): Result {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail("Counter policy must be an object.");
  const doc = input as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "onlinePaymentMethods",
    "offlineEnabled",
    "offlineExternalCardEnabled",
    "externalCardMerchants",
    "registerNumbering",
  ];
  if (Object.keys(doc).some((key) => !keys.includes(key)))
    return fail("Counter policy contains unknown settings.");
  if (
    doc.schemaVersion !== COUNTER_POLICY_SCHEMA_VERSION ||
    typeof doc.offlineEnabled !== "boolean" ||
    typeof doc.offlineExternalCardEnabled !== "boolean"
  ) {
    return fail("Counter policy needs version 2 and explicit offline switches.");
  }

  const methods = parseOnlineMethods(doc.onlinePaymentMethods);
  if (!methods.ok) return methods;
  const merchants = parseMerchants(doc.externalCardMerchants);
  if (!merchants.ok) return merchants;
  const numbering = parseNumbering(doc.registerNumbering);
  if (!numbering.ok) return numbering;

  if (doc.offlineExternalCardEnabled && (!doc.offlineEnabled || merchants.value.length === 0))
    return fail("External card offline needs offline selling enabled and at least one merchant.");
  return {
    ok: true,
    value: {
      schemaVersion: COUNTER_POLICY_SCHEMA_VERSION,
      onlinePaymentMethods: methods.value,
      offlineEnabled: doc.offlineEnabled,
      offlineExternalCardEnabled: doc.offlineExternalCardEnabled,
      externalCardMerchants: merchants.value,
      registerNumbering: numbering.value,
    },
  };
}

function parseOnlineMethods(
  raw: unknown,
): { ok: true; value: OnlinePaymentMethod[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return fail("List the online payment methods, even if there are none.");
  if (raw.includes("cash")) return fail("Cash is always accepted; it isn't a setting.");
  if (raw.some((m) => !(ONLINE_PAYMENT_METHODS as readonly unknown[]).includes(m)))
    return fail("Unknown online payment method.");
  if (new Set(raw).size !== raw.length) return fail("An online payment method is listed twice.");
  // Stored in catalogue order, so the same choice always has the same document.
  return { ok: true, value: ONLINE_PAYMENT_METHODS.filter((m) => raw.includes(m)) };
}

function parseMerchants(
  raw: unknown,
): { ok: true; value: ExternalCardMerchant[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length > MAX_EXTERNAL_CARD_MERCHANTS)
    return fail(`Use at most ${MAX_EXTERNAL_CARD_MERCHANTS} external-card merchants.`);
  const merchants: ExternalCardMerchant[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).some((key) => !["provider", "merchantId"].includes(key))
    )
      return fail("Each merchant needs only a provider and merchant ID.");
    const { provider, merchantId } = row as Record<string, unknown>;
    if (typeof provider !== "string" || typeof merchantId !== "string")
      return fail("Each merchant needs a provider and merchant ID.");
    const p = provider.trim().normalize("NFC");
    const m = merchantId.trim().normalize("NFC");
    if (!p || p.length > 80 || !m || m.length > 120 || CONTROL.test(p + m))
      return fail(
        "Use a provider of 1–80 characters and a merchant ID of 1–120 characters, without control characters.",
      );
    // Provider labels are case-insensitive; merchant identifiers retain their exact case.
    const key = JSON.stringify([p.toLowerCase(), m]);
    if (seen.has(key)) return fail("That provider and merchant ID are listed more than once.");
    seen.add(key);
    merchants.push({ provider: p, merchantId: m });
  }
  return { ok: true, value: merchants };
}

function parseNumbering(
  raw: unknown,
): { ok: true; value: RegisterNumbering[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length > MAX_REGISTER_NUMBERING)
    return fail(`Number at most ${MAX_REGISTER_NUMBERING} registers.`);
  const rows: RegisterNumbering[] = [];
  const registers = new Set<string>();
  for (const row of raw) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).some((key) => !["registerId", "receiptPrefix", "invoicePrefix"].includes(key))
    )
      return fail("Each register needs only its ID, receipt prefix and invoice prefix.");
    const { registerId, receiptPrefix, invoicePrefix } = row as Record<string, unknown>;
    if (typeof registerId !== "string" || !UUID.test(registerId))
      return fail("Each numbered register needs its register ID.");
    const id = registerId.toLowerCase();
    if (registers.has(id)) return fail("A register is numbered twice.");
    registers.add(id);
    const receipt = normalizePrefix(receiptPrefix);
    const invoice = normalizePrefix(invoicePrefix);
    if (!receipt || !invoice)
      return fail(
        `Prefixes are 1–${MAX_REGISTER_PREFIX_LENGTH} letters, digits or hyphens, starting with a letter or digit.`,
      );
    rows.push({ registerId: id, receiptPrefix: receipt, invoicePrefix: invoice });
  }
  // Numbers are unique per branch and found by prefix match, so no prefix may begin another —
  // "C1" and "C10" would both claim "C10005".
  const prefixes = [ONLINE_INVOICE_PREFIX, ...rows.flatMap((r) => [r.receiptPrefix, r.invoicePrefix])];
  for (let i = 0; i < prefixes.length; i += 1) {
    for (let j = i + 1; j < prefixes.length; j += 1) {
      const [a, b] = [prefixes[i], prefixes[j]];
      if (a.startsWith(b) || b.startsWith(a)) {
        return fail(
          i === 0
            ? `${b} overlaps the online invoice series (${ONLINE_INVOICE_PREFIX}). Choose another prefix.`
            : `${a} and ${b} overlap: one begins the other. Give every receipt and invoice series its own prefix.`,
        );
      }
    }
  }
  return { ok: true, value: rows };
}

function normalizePrefix(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  return value.length <= MAX_REGISTER_PREFIX_LENGTH && PREFIX.test(value) ? value : null;
}

/** Choices for the tenant-wide default payment method (Settings → Counters & receipts). */
export const COUNTER_DEFAULT_PAYMENT_METHODS = ["cash", "card", "split"] as const;
export type CounterDefaultPaymentMethod = (typeof COUNTER_DEFAULT_PAYMENT_METHODS)[number];

/**
 * The default every branch's counters start a sale on. The default is tenant-wide but card is a
 * branch choice, so a branch that doesn't take card online starts on cash instead. Split tender
 * is cash plus card and needs card too. Anything unrecognised also falls back to cash, which is
 * always accepted.
 */
export function effectiveDefaultPaymentMethod(
  tenantDefault: string,
  onlinePaymentMethods: readonly OnlinePaymentMethod[],
): CounterDefaultPaymentMethod {
  if (tenantDefault === "card" || tenantDefault === "split")
    return onlinePaymentMethods.includes("card") ? tenantDefault : "cash";
  return "cash";
}
