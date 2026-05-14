"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { apiJson } from "@/lib/auth-client";

type AdminUser = {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  userBranchRoles: Array<{ id: string; branchId: string; role: string }>;
};

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiJson<AdminUser[]>("/admin/users")
      .then(setUsers)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed (manager/owner only)"));
  }, []);

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Users</h1>
      {err ? <Alert variant="error">{err}</Alert> : null}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {users.map((u) => (
          <li
            key={u.id}
            style={{
              border: "1px solid var(--pc-border)",
              borderRadius: "var(--pc-radius-sm)",
              padding: "0.75rem",
              marginBottom: 8,
              background: "var(--pc-background)",
            }}
          >
            <strong>{u.fullName}</strong> — {u.email}
            <div style={{ fontSize: "0.85rem", color: "var(--pc-muted-fg)", marginTop: 6 }}>
              {u.userBranchRoles.map((r) => (
                <span key={r.id} style={{ marginRight: 8 }}>
                  {r.role} @ <code>{r.branchId.slice(0, 8)}…</code>
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
