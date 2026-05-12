import Link from "next/link";
import { APP_NAME } from "@pharmaceylon/shared";

export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: "2rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>{APP_NAME}</h1>
      <p style={{ maxWidth: 520, textAlign: "center", color: "#444", marginBottom: "1.25rem" }}>
        Next.js app for the product UI. Run the API on port 3001 and open{" "}
        <Link href="/login" style={{ color: "#2563eb" }}>
          Sign in
        </Link>{" "}
        to exercise login, refresh, and branch-scoped calls. See{" "}
        <code style={{ fontSize: "0.9em" }}>docs/LOCAL_DEV.md</code> in the repo.
      </p>
      <p style={{ display: "flex", gap: "1rem" }}>
        <Link
          href="/login"
          style={{
            padding: "0.5rem 1rem",
            background: "#111827",
            color: "#fff",
            borderRadius: 6,
            textDecoration: "none",
          }}
        >
          Sign in
        </Link>
        <Link
          href="/dashboard"
          style={{
            padding: "0.5rem 1rem",
            border: "1px solid #ccc",
            borderRadius: 6,
            textDecoration: "none",
            color: "#111",
          }}
        >
          Dashboard
        </Link>
      </p>
    </main>
  );
}
