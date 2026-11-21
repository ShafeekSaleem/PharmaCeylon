import type { SalesHistoryOptions, SalesHistoryRegisterOption } from "./types";

export type RegisterPickOption = {
  registerId: string;
  tillId: string;
  /** Counter / register name from the API (`register.label`). */
  counterLabel: string;
  /** Till display name when the API provides one; otherwise null. */
  tillLabel: string | null;
};

/** Registers for counter/till pickers, scoped to the active branch when one is selected. */
export function registersForPicker(
  registers: readonly SalesHistoryRegisterOption[],
  branchId: string | null,
  branches: SalesHistoryOptions["branches"],
): RegisterPickOption[] {
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const scoped = branchId ? registers.filter((r) => r.branchId === branchId) : registers;
  return scoped.map((r) => {
    const suffix = branchId ? null : branchName.get(r.branchId);
    const counterLabel = suffix ? `${r.label} · ${suffix}` : r.label;
    return {
      registerId: r.registerId,
      tillId: r.tillId,
      counterLabel,
      tillLabel: r.tillLabel ?? null,
    };
  });
}

export function counterFilterOptions(
  picks: readonly RegisterPickOption[],
  allLabel: string,
): { value: string; label: string }[] {
  return [{ value: "all", label: allLabel }, ...picks.map((r) => ({ value: r.registerId, label: r.counterLabel }))];
}

export function receiptScopeOptions(
  picks: readonly RegisterPickOption[],
): { value: string; label: string }[] {
  return [{ value: "any", label: "Any counter" }, ...picks.map((r) => ({ value: r.registerId, label: r.counterLabel }))];
}

export function tillFilterOptions(
  picks: readonly RegisterPickOption[],
): { value: string; label: string }[] {
  const unique = new Map<string, string>();
  for (const pick of picks) {
    if (pick.tillLabel && !unique.has(pick.tillId)) {
      unique.set(pick.tillId, pick.tillLabel);
    }
  }
  if (unique.size === 0) return [];
  return [{ value: "all", label: "All tills" }, ...[...unique.entries()].map(([value, label]) => ({ value, label }))];
}

export function tillLabelForId(tillId: string, picks: readonly RegisterPickOption[]): string | undefined {
  return picks.find((p) => p.tillId === tillId && p.tillLabel)?.tillLabel ?? undefined;
}

export function hasTillFilterOptions(picks: readonly RegisterPickOption[]): boolean {
  return picks.some((p) => Boolean(p.tillLabel));
}
