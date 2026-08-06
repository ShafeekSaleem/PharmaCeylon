export type MatchType = "exact" | "generic" | "alias" | "partial";

export type MatchInfo = {
  matchType: MatchType;
  matchField: string;
  rank: number;
};

export function normalizeCatalogTerm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** Heuristic: SKU/barcode-like tokens (no spaces, mostly digits or SKU shape). */
export function looksLikeProductCode(term: string): boolean {
  const t = term.trim();
  if (t.length < 3) return false;
  if (/\s/.test(t)) return false;
  const digitRatio = (t.match(/\d/g) ?? []).length / t.length;
  if (digitRatio >= 0.5) return true;
  // SKU-like: letters + digits (optional separator), e.g. PCL-0001 / AMLO5
  return /^[a-z]{1,8}[-_/]?\d{2,}$/i.test(t);
}

export function scoreMatch(
  term: string,
  product: {
    sku: string;
    barcode: string | null;
    name: string;
    brandName: string | null;
    genericName: string | null;
    registrationNo?: string | null;
    aliases?: { aliasText: string }[];
  },
  exactOnly: boolean,
): MatchInfo | null {
  const t = normalizeCatalogTerm(term);
  if (!t) {
    return { matchType: "partial", matchField: "name", rank: 90 };
  }

  const sku = normalizeCatalogTerm(product.sku);
  const barcode = normalizeCatalogTerm(product.barcode);
  const name = normalizeCatalogTerm(product.name);
  const brand = normalizeCatalogTerm(product.brandName);
  const generic = normalizeCatalogTerm(product.genericName);
  const registrationNo = normalizeCatalogTerm(product.registrationNo);
  const aliases = (product.aliases ?? []).map((a) =>
    normalizeCatalogTerm(a.aliasText),
  );

  if (sku === t || barcode === t || registrationNo === t) {
    return {
      matchType: "exact",
      matchField: sku === t ? "sku" : barcode === t ? "barcode" : "registrationNo",
      rank: 0,
    };
  }
  if (name === t) {
    return { matchType: "exact", matchField: "name", rank: 1 };
  }
  if (exactOnly) {
    if (
      sku.startsWith(t) ||
      barcode.startsWith(t) ||
      registrationNo.startsWith(t) ||
      name.startsWith(t)
    ) {
      return {
        matchType: "exact",
        matchField: sku.startsWith(t)
          ? "sku"
          : barcode.startsWith(t)
            ? "barcode"
            : registrationNo.startsWith(t)
              ? "registrationNo"
              : "name",
        rank: 5,
      };
    }
    return null;
  }

  if (generic === t || generic.startsWith(t)) {
    return { matchType: "generic", matchField: "genericName", rank: 10 };
  }
  if (aliases.some((a) => a === t || a.startsWith(t))) {
    return { matchType: "alias", matchField: "alias", rank: 20 };
  }
  if (
    name.startsWith(t) ||
    brand.startsWith(t) ||
    sku.startsWith(t) ||
    barcode.startsWith(t) ||
    registrationNo.startsWith(t)
  ) {
    return {
      matchType: "partial",
      matchField: name.startsWith(t)
        ? "name"
        : brand.startsWith(t)
          ? "brandName"
          : sku.startsWith(t)
            ? "sku"
            : barcode.startsWith(t)
              ? "barcode"
              : "registrationNo",
      rank: 30,
    };
  }
  if (
    name.includes(t) ||
    brand.includes(t) ||
    generic.includes(t) ||
    sku.includes(t) ||
    barcode.includes(t) ||
    registrationNo.includes(t) ||
    aliases.some((a) => a.includes(t))
  ) {
    const field = name.includes(t)
      ? "name"
      : brand.includes(t)
        ? "brandName"
        : generic.includes(t)
          ? "genericName"
          : aliases.some((a) => a.includes(t))
            ? "alias"
            : sku.includes(t)
              ? "sku"
              : barcode.includes(t)
                ? "barcode"
                : "registrationNo";
    return {
      matchType:
        field === "genericName" ? "generic" : field === "alias" ? "alias" : "partial",
      matchField: field,
      rank: 40,
    };
  }
  return null;
}

export function stockStatus(
  qty: number,
  reorderLevel: number,
): "healthy" | "low" | "out" {
  if (qty <= 0) return "out";
  if (reorderLevel > 0 && qty <= reorderLevel) return "low";
  return "healthy";
}
