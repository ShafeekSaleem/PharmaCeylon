"use client";

import { useEffect, useState } from "react";
import { PmsNav } from "@/components/pms-nav";
import { apiJson } from "@/lib/auth-client";
import { useRequireAuth } from "@/lib/use-require-auth";

type AdminUser = {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  userBranchRoles: Array<{ id: string; branchId: string; role: string }>;
};

export default function UsersPage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !isAuthenticated) return;
    apiJson<AdminUser[]>("/admin/users")
      .then(setUsers)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed (manager/owner only)"));
  }, [ready, isAuthenticated]);

  if (!ready || !isAuthenticated) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        Loading…
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "1.5rem",
        fontFamily: "system-ui, sans-serif",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <PmsNav />
      <h1 style={{ marginTop: 0 }}>Users</h1>
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {users.map((u) => (
          <li
            key={u.id}
            style={{
              border: "1px solid #e4e4e7",
              borderRadius: 6,
              padding: "0.75rem",
              marginBottom: 8,
            }}
          >
            <strong>{u.fullName}</strong> — {u.email}
            <div style={{ fontSize: "0.85rem", color: "#666", marginTop: 6 }}>
              {u.userBranchRoles.map((r) => (
                <span key={r.id} style={{ marginRight: 8 }}>
                  {r.role} @ <code>{r.branchId.slice(0, 8)}…</code>
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
