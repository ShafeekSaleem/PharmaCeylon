"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import type { AdminUser } from "../types";

export function useAdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson<AdminUser[]>("/admin/users");
      setUsers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load staff (owner/manager only)");
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { users, loading, error, reload };
}
