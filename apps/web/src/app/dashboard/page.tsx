"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PmsNav } from "@/components/pms-nav";
import { apiFetch, fetchTenantBranches, fetchTenantContext } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";

export default function DashboardPage() {
  const router = useRouter();
  const { user, ready, isAuthenticated, branchId, setBranchId, logout, logoutAll } = useAuth();
  const [context, setContext] = useState<unknown>(null);
  const [branches, setBranches] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [management, setManagement] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!isAuthenticated) {
      router.replace("/login");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [ctx, br] = await Promise.all([fetchTenantContext(), fetchTenantBranches()]);
        if (!cancelled) {
          setContext(ctx);
          setBranches(br);
          setLoadError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Failed to load context");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, isAuthenticated, router, branchId]);

  async function probeManagement() {
    setManagement(null);
    setLoadError(null);
    try {
      const res = await apiFetch("/tenant/management");
      const text = await res.text();
      if (res.ok) {
        setManagement(`OK (${res.status}): ${text}`);
      } else {
        setManagement(`Denied (${res.status}): ${text}`);
      }
    } catch (e) {
      setManagement(e instanceof Error ? e.message : "Request failed");
    }
  }

  if (!ready) {
    return (
      <main className="pc-app-main">
        <p className="pc-muted">Loading…</p>
      </main>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <main className="pc-app-main" style={{ maxWidth: 720 }}>
      <PmsNav />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0, color: "var(--pc-foreground)" }}>Dashboard</h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <Link href="/">Home</Link>
          <button
            type="button"
            className="pc-btn-outline"
            onClick={async () => {
              await logout();
              router.push("/login");
            }}
          >
            Log out
          </button>
          <button
            type="button"
            className="pc-btn-outline"
            onClick={async () => {
              await logoutAll();
              router.push("/login");
            }}
            title="Sign out from every device and invalidate all tokens"
          >
            Log out everywhere
          </button>
        </div>
      </div>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem", color: "var(--pc-foreground)" }}>Session</h2>
        <p style={{ margin: "0.25rem 0" }}>
          <strong>{user?.fullName}</strong> ({user?.email})
        </p>
        <label style={{ display: "block", marginTop: "0.75rem" }}>
          <span style={{ display: "block", marginBottom: 4, color: "var(--pc-muted-fg)", fontSize: "0.9rem" }}>
            Branch for API calls (x-branch-id)
          </span>
          <select
            value={branchId ?? ""}
            onChange={(e) => setBranchId(e.target.value || null)}
            style={{
              minWidth: 280,
              padding: "0.45rem 0.6rem",
              fontSize: "1rem",
              border: "1px solid var(--pc-border)",
              borderRadius: "var(--pc-radius-sm)",
              background: "var(--pc-input-bg)",
              color: "var(--pc-foreground)",
            }}
          >
            <option value="">None</option>
            {(user?.branchRoles ?? []).map((br) => {
              const meta = branches.find((b) => b.id === br.branchId);
              const label = meta ? `${meta.code} — ${meta.name}` : `${br.branchId.slice(0, 8)}…`;
              return (
                <option key={br.branchId} value={br.branchId}>
                  {label} ({br.role})
                </option>
              );
            })}
          </select>
        </label>
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem", color: "var(--pc-foreground)" }}>GET /tenant/context</h2>
        {loadError ? <Alert variant="error">{loadError}</Alert> : null}
        <pre className="pc-panel" style={{ marginTop: 8 }}>
          {context ? JSON.stringify(context, null, 2) : "Loading…"}
        </pre>
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem", color: "var(--pc-foreground)" }}>Role check</h2>
        <p className="pc-muted" style={{ fontSize: "0.9rem" }}>
          Calls <code>/tenant/management</code> (manager or owner). Pick a branch above if you are not owner.
        </p>
        <button type="button" className="pc-btn-primary-sm" onClick={probeManagement} style={{ marginTop: 8 }}>
          Call management endpoint
        </button>
        {management ? (
          <pre className="pc-panel" style={{ marginTop: 8 }}>
            {management}
          </pre>
        ) : null}
      </section>
    </main>
  );
}
