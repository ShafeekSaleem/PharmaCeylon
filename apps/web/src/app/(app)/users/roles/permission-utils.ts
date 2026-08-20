import type { PermissionDef, PermissionGrantFilter, PermissionModule } from "./types";

export function buildPermissionIndex(modules: PermissionModule[]): Map<string, PermissionDef> {
  const index = new Map<string, PermissionDef>();
  for (const mod of modules) {
    for (const perm of mod.permissions) {
      index.set(perm.key, perm);
    }
  }
  return index;
}

export function sameKeySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((key) => set.has(key));
}

export function matchesSearch(perm: PermissionDef, moduleLabel: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    perm.label.toLowerCase().includes(q) ||
    perm.description.toLowerCase().includes(q) ||
    moduleLabel.toLowerCase().includes(q)
  );
}

export function matchesFilter(
  perm: PermissionDef,
  granted: boolean,
  filter: PermissionGrantFilter,
): boolean {
  switch (filter) {
    case "granted":
      return granted;
    case "not_granted":
      return !granted;
    case "sensitive":
      return perm.riskLevel === "sensitive" || perm.riskLevel === "elevated";
    default:
      return true;
  }
}

export function countGranted(permissions: PermissionDef[], grantedKeys: Set<string>) {
  let granted = 0;
  for (const perm of permissions) {
    if (grantedKeys.has(perm.key)) granted += 1;
  }
  return { granted, total: permissions.length };
}

/**
 * Enabling `key` also enables every prerequisite it (transitively) depends
 * on that isn't already granted. Returns the updated grant set plus the
 * defs that got auto-added, so the caller can surface what happened.
 */
export function resolveEnableWithDependencies(
  key: string,
  grantedKeys: Set<string>,
  index: Map<string, PermissionDef>,
): { nextKeys: Set<string>; added: PermissionDef[] } {
  const next = new Set(grantedKeys);
  const added: PermissionDef[] = [];
  const queue = [key];
  next.add(key);

  while (queue.length) {
    const current = queue.shift()!;
    const def = index.get(current);
    for (const dep of def?.dependencies ?? []) {
      if (!next.has(dep)) {
        next.add(dep);
        const depDef = index.get(dep);
        if (depDef) added.push(depDef);
        queue.push(dep);
      }
    }
  }

  return { nextKeys: next, added };
}

/** Every currently-granted permission whose dependency chain includes `key`. */
export function findDependents(
  key: string,
  grantedKeys: Set<string>,
  index: Map<string, PermissionDef>,
): PermissionDef[] {
  function dependsOn(candidate: string, target: string, seen = new Set<string>()): boolean {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    const def = index.get(candidate);
    for (const dep of def?.dependencies ?? []) {
      if (dep === target) return true;
      if (dependsOn(dep, target, seen)) return true;
    }
    return false;
  }

  const dependents: PermissionDef[] = [];
  for (const granted of grantedKeys) {
    if (granted === key) continue;
    if (dependsOn(granted, key)) {
      const def = index.get(granted);
      if (def) dependents.push(def);
    }
  }
  return dependents;
}

/** Disabling `key` cascades to every granted permission that depends on it. */
export function resolveDisableWithDependents(
  key: string,
  grantedKeys: Set<string>,
  index: Map<string, PermissionDef>,
): { nextKeys: Set<string>; removed: PermissionDef[] } {
  const removed = findDependents(key, grantedKeys, index);
  const next = new Set(grantedKeys);
  next.delete(key);
  for (const dep of removed) next.delete(dep.key);
  return { nextKeys: next, removed };
}

export type RiskSummary = {
  totalGranted: number;
  totalPermissions: number;
  elevatedGranted: number;
  sensitiveGranted: number;
};

export function summarizeGrants(modules: PermissionModule[], grantedKeys: Set<string>): RiskSummary {
  let totalGranted = 0;
  let totalPermissions = 0;
  let elevatedGranted = 0;
  let sensitiveGranted = 0;
  for (const mod of modules) {
    for (const perm of mod.permissions) {
      totalPermissions += 1;
      if (grantedKeys.has(perm.key)) {
        totalGranted += 1;
        if (perm.riskLevel === "elevated") elevatedGranted += 1;
        if (perm.riskLevel === "sensitive") sensitiveGranted += 1;
      }
    }
  }
  return { totalGranted, totalPermissions, elevatedGranted, sensitiveGranted };
}
