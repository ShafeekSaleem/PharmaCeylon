"use client";

import { useEffect, useState } from "react";
import { fetchRoles } from "../roles/api";
import type { RoleRow } from "../roles/types";

/** Built-in + custom roles for this tenant, used to populate role-assignment dropdowns. */
export function useRoles() {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchRoles()
      .then((rows) => {
        if (!cancelled) setRoles(rows);
      })
      .catch(() => {
        if (!cancelled) setRoles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { roles, loading };
}
