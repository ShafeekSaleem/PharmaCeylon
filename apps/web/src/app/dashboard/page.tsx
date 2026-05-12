"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, fetchTenantContext } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";

export default function DashboardPage() {
  const router = useRouter();
  const { user, ready, isAuthenticated, branchId, setBranchId, logout, logoutAll } = useAuth();
  const [context, setContext] = useState<unknown>(null);
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
        const ctx = await fetchTenantContext();
        if (!cancelled) {
          setContext(ctx);
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
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        Loading…
      </main>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "1.5rem",
        fontFamily: "system-ui, sans-serif",
        maxWidth: 720,
        margin: "0 auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0 }}>Dashboard</h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link href="/" style={{ color: "#2563eb" }}>
            Home
          </Link>
          <button
            type="button"
            onClick={async () => {
              await logout();
              router.push("/login");
            }}
            style={{ padding: "0.35rem 0.75rem", cursor: "pointer" }}
          >
            Log out
          </button>
          <button
            type="button"
            onClick={async () => {
              await logoutAll();
              router.push("/login");
            }}
            title="Sign out from every device and invalidate all tokens"
            style={{ padding: "0.35rem 0.75rem", cursor: "pointer" }}
          >
            Log out everywhere
          </button>
        </div>
      </div>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Session</h2>
        <p style={{ margin: "0.25rem 0" }}>
          <strong>{user?.fullName}</strong> ({user?.email})
        </p>
        <label style={{ display: "block", marginTop: "0.75rem" }}>
          <span style={{ display: "block", marginBottom: 4 }}>Branch for API calls (x-branch-id)</span>
          <select
            value={branchId ?? ""}
            onChange={(e) => setBranchId(e.target.value || null)}
            style={{ minWidth: 280, padding: "0.35rem 0.5rem", fontSize: "1rem" }}
          >
            <option value="">None</option>
            {(user?.branchRoles ?? []).map((br) => (
              <option key={br.branchId} value={br.branchId}>
                {br.branchId.slice(0, 8)}… — {br.role}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>GET /tenant/context</h2>
        {loadError ? <p style={{ color: "#b91c1c" }}>{loadError}</p> : null}
        <pre
          style={{
            background: "#f4f4f5",
            padding: "0.75rem",
            borderRadius: 6,
            overflow: "auto",
            fontSize: "0.85rem",
          }}
        >
          {context ? JSON.stringify(context, null, 2) : "Loading…"}
        </pre>
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Role check</h2>
        <p style={{ color: "#555", fontSize: "0.9rem" }}>
          Calls <code>/tenant/management</code> (manager or owner). Pick a branch above if you are not owner.
        </p>
        <button type="button" onClick={probeManagement} style={{ marginTop: 8, padding: "0.4rem 0.9rem" }}>
          Call management endpoint
        </button>
        {management ? (
          <pre
            style={{
              marginTop: 8,
              background: "#f4f4f5",
              padding: "0.75rem",
              borderRadius: 6,
              fontSize: "0.85rem",
            }}
          >
            {management}
          </pre>
        ) : null}
      </section>
    </main>
  );
}
