import Link from "next/link";
import { APP_NAME } from "@pharmaceylon/shared";

export default function HomePage() {
  return (
    <main
      className="pc-app-main"
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem", color: "var(--pc-foreground)" }}>{APP_NAME}</h1>
      <p style={{ maxWidth: 520, color: "var(--pc-muted-fg)", marginBottom: "1.25rem" }}>
        Next.js app for the product UI. Run the API on port 3001 and open <Link href="/login">Sign in</Link> to
        exercise login, refresh, and branch-scoped calls. See <code style={{ fontSize: "0.9em" }}>docs/LOCAL_DEV.md</code>{" "}
        in the repo.
      </p>
      <p style={{ display: "flex", gap: "1rem", flexWrap: "wrap", justifyContent: "center" }}>
        <Link
          href="/login"
          style={{
            padding: "0.55rem 1.15rem",
            background: "var(--pc-primary)",
            color: "#fff",
            borderRadius: "var(--pc-radius-sm)",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Sign in
        </Link>
        <Link
          href="/dashboard"
          style={{
            padding: "0.55rem 1.15rem",
            border: "1px solid var(--pc-border)",
            borderRadius: "var(--pc-radius-sm)",
            textDecoration: "none",
            color: "var(--pc-foreground)",
            background: "var(--pc-background)",
          }}
        >
          Dashboard
        </Link>
      </p>
    </main>
  );
}
