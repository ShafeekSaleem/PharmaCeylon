"use client";

import { useEffect, useState } from "react";
import { usePermissions } from "@/lib/permissions";
import { fetchTenantSettings, type TenantSettings } from "./tenant-settings";

/**
 * The tenant settings document for one card on a settings page. Each card loads it on its own,
 * so a card that moves to another page (the Counters / Receipts / Payments split) takes its
 * read with it, and saves only its own slice.
 */
export function useTenantSettings(): {
  settings: TenantSettings | null;
  setSettings: (settings: TenantSettings) => void;
  error: string | null;
  canEdit: boolean;
} {
  const { permissionKeys } = usePermissions();
  const canEdit = permissionKeys.includes("tenant.management");
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTenantSettings().then(
      (s) => {
        if (!cancelled) setSettings(s);
      },
      (e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load settings.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return { settings, setSettings, error, canEdit };
}
