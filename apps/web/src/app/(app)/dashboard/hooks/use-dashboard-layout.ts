"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import type { DashboardRole } from "../lib/dashboard-role";
import { DEFAULT_LAYOUTS } from "../widgets/default-layouts";
import type { WidgetDef, WidgetInstance } from "../widgets/types";

type SavedLayoutResponse = { widgets: WidgetInstance[]; updatedAt: string } | null;

function sameLayout(a: WidgetInstance[], b: WidgetInstance[]): boolean {
  if (a.length !== b.length) return false;
  const sortKey = (w: WidgetInstance) => w.key;
  const as = [...a].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  const bs = [...b].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  return as.every((item, i) => {
    const other = bs[i]!;
    return item.key === other.key && item.x === other.x && item.y === other.y;
  });
}

/** Loads/persists this user's canvas layout for `role`, falling back to the
 * role's default arrangement when nothing is saved yet. `catalog` is that
 * role's full widget registry slice — needed to size a widget when it's
 * added and to drop instances whose widget no longer exists. */
export function useDashboardLayout(role: DashboardRole, catalog: WidgetDef[]) {
  const defaultLayout = useMemo(() => DEFAULT_LAYOUTS[role] ?? [], [role]);
  const catalogKeys = useMemo(() => new Set(catalog.map((w) => w.key)), [catalog]);

  const [savedLayout, setSavedLayout] = useState<WidgetInstance[]>(defaultLayout);
  const [draftLayout, setDraftLayout] = useState<WidgetInstance[]>(defaultLayout);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiJson<SavedLayoutResponse>("/dashboard/layout")
      .then((res) => {
        if (cancelled) return;
        const widgets = res?.widgets?.filter((w) => catalogKeys.has(w.key));
        const resolved = widgets && widgets.length > 0 ? widgets : defaultLayout;
        setSavedLayout(resolved);
        setDraftLayout(resolved);
      })
      .catch(() => {
        if (cancelled) return;
        setSavedLayout(defaultLayout);
        setDraftLayout(defaultLayout);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-run only when the role (and therefore its default/catalog) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const isDirty = useMemo(() => !sameLayout(draftLayout, savedLayout), [draftLayout, savedLayout]);

  const addWidget = useCallback(
    (key: string) => {
      const def = catalog.find((w) => w.key === key);
      if (!def) return;
      setDraftLayout((prev) => {
        if (prev.some((w) => w.key === key)) return prev;
        // Append below the tallest existing widget — height comes from each
        // widget's fixed registry size, never from stored state.
        const y = prev.reduce((max, w) => {
          const existingDef = catalog.find((d) => d.key === w.key);
          const h = existingDef ? existingDef.rows : 0;
          return Math.max(max, w.y + h);
        }, 0);
        return [...prev, { key, x: 0, y }];
      });
    },
    [catalog],
  );

  const removeWidget = useCallback((key: string) => {
    setDraftLayout((prev) => prev.filter((w) => w.key !== key));
  }, []);

  const updateLayout = useCallback((next: WidgetInstance[]) => {
    setDraftLayout(next);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await apiJson<{ widgets: WidgetInstance[] }>("/dashboard/layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ widgets: draftLayout }),
      });
      setSavedLayout(res.widgets);
      setDraftLayout(res.widgets);
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  }, [draftLayout]);

  const discard = useCallback(() => {
    setDraftLayout(savedLayout);
    setIsEditing(false);
  }, [savedLayout]);

  const resetToDefault = useCallback(async () => {
    setSaving(true);
    try {
      await apiJson("/dashboard/layout", { method: "DELETE" });
      setSavedLayout(defaultLayout);
      setDraftLayout(defaultLayout);
    } finally {
      setSaving(false);
    }
  }, [defaultLayout]);

  return {
    layout: draftLayout,
    isEditing,
    setIsEditing,
    loading,
    saving,
    isDirty,
    addWidget,
    removeWidget,
    updateLayout,
    save,
    discard,
    resetToDefault,
  };
}

export type UseDashboardLayoutResult = ReturnType<typeof useDashboardLayout>;
