import { Prisma } from "@prisma/client";

/** Back-office and till invoice matching — partial and suffix, including short receipt numbers at a counter. */
export function invoiceNoWhere(term: string, counterScoped: boolean): Prisma.SaleWhereInput {
  if (!counterScoped) {
    return { invoiceNo: { contains: term, mode: "insensitive" } };
  }
  const or: Prisma.SaleWhereInput[] = [
    { invoiceNo: { contains: term, mode: "insensitive" } },
    { invoiceNo: { endsWith: term, mode: "insensitive" } },
  ];
  const trailingDigits = term.match(/(\d+)$/)?.[1];
  if (trailingDigits && trailingDigits.length > 0) {
    or.push({ invoiceNo: { endsWith: trailingDigits, mode: "insensitive" } });
    or.push({
      invoiceNo: { endsWith: `-${trailingDigits.padStart(6, "0")}`, mode: "insensitive" },
    });
  } else if (/^\d+$/.test(term)) {
    or.push({ invoiceNo: { endsWith: term, mode: "insensitive" } });
    or.push({ invoiceNo: { endsWith: `-${term.padStart(6, "0")}`, mode: "insensitive" } });
  }
  return { OR: or };
}