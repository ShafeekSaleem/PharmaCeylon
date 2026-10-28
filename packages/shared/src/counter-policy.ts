/** W7 settings source. P3 must sign these values; saving does not nominate a device or
 * renew/revoke a disconnected counter's existing permission. Fixed v1 rules are not editable. */
export const COUNTER_OFFLINE_RULES = Object.freeze({
  permissionHours: 24,
  snapshotFreshnessMinutes: 15,
  ordinaryItemsOnly: true,
  discountsAllowed: false,
});

export type ExternalCardMerchant = { provider: string; merchantId: string };
export type CounterPolicy = {
  schemaVersion: 1;
  offlineEnabled: boolean;
  offlineExternalCardEnabled: boolean;
  externalCardMerchants: ExternalCardMerchant[];
};
export type CounterPolicyView = {
  branchId: string;
  branchName: string;
  version: number;
  policy: CounterPolicy;
  canEdit: boolean;
};

export function defaultCounterPolicy(): CounterPolicy {
  return {
    schemaVersion: 1,
    offlineEnabled: false,
    offlineExternalCardEnabled: false,
    externalCardMerchants: [],
  };
}

export function validateCounterPolicy(
  input: unknown,
): { ok: true; value: CounterPolicy } | { ok: false; message: string } {
  const fail = (message: string) => ({ ok: false as const, message });
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail("Counter policy must be an object.");
  const doc = input as Record<string, unknown>;
  if (
    Object.keys(doc).some(
      (key) =>
        ![
          "schemaVersion",
          "offlineEnabled",
          "offlineExternalCardEnabled",
          "externalCardMerchants",
        ].includes(key),
    )
  ) {
    return fail("Counter policy contains unknown settings.");
  }
  if (
    doc.schemaVersion !== 1 ||
    typeof doc.offlineEnabled !== "boolean" ||
    typeof doc.offlineExternalCardEnabled !== "boolean"
  ) {
    return fail(
      "Counter policy needs version 1 and explicit offline switches.",
    );
  }
  if (
    !Array.isArray(doc.externalCardMerchants) ||
    doc.externalCardMerchants.length > 20
  )
    return fail("Use at most 20 external-card merchants.");
  const merchants: ExternalCardMerchant[] = [];
  const seen = new Set<string>();
  for (const row of doc.externalCardMerchants) {
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
    if (
      !p ||
      p.length > 80 ||
      !m ||
      m.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(p + m)
    )
      return fail(
        "Use a provider of 1–80 characters and a merchant ID of 1–120 characters, without control characters.",
      );
    // Provider labels are case-insensitive; merchant identifiers retain their exact case.
    const key = JSON.stringify([p.toLowerCase(), m]);
    if (seen.has(key))
      return fail("That provider and merchant ID are listed more than once.");
    seen.add(key);
    merchants.push({ provider: p, merchantId: m });
  }
  if (
    doc.offlineExternalCardEnabled &&
    (!doc.offlineEnabled || merchants.length === 0)
  )
    return fail(
      "External card offline needs offline selling enabled and at least one merchant.",
    );
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      offlineEnabled: doc.offlineEnabled,
      offlineExternalCardEnabled: doc.offlineExternalCardEnabled,
      externalCardMerchants: merchants,
    },
  };
}
