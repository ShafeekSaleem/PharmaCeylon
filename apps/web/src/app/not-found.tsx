import Link from "next/link";

export default function NotFound() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", textAlign: "center" }}>
      <h1>Page not found</h1>
      <p>
        <Link href="/" style={{ color: "#2563eb" }}>
          Back to home
        </Link>
      </p>
    </main>
  );
}
