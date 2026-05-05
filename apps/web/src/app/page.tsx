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
      <p style={{ maxWidth: 520, textAlign: "center", color: "#444" }}>
        Marketing site and product app will live here (Next.js). API runs separately on port 3001.
      </p>
    </main>
  );
}
