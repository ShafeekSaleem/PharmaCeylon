import Link from "next/link";

export default function NotFound() {
  return (
    <main className="pc-app-main" style={{ textAlign: "center" }}>
      <h1 style={{ color: "var(--pc-foreground)" }}>Page not found</h1>
      <p>
        <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
