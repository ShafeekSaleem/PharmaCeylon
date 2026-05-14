"use client";

export default function SettingsPage() {
  return (
    <div style={{ background: "var(--pc-card-bg)", borderRadius: "var(--pc-radius-md)", padding: "2rem", border: "1px solid var(--pc-border)" }}>
      <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.25rem", fontWeight: 600 }}>Settings</h2>
      <p style={{ color: "var(--pc-muted-fg)", margin: 0 }}>
        Application settings will appear here.
      </p>
    </div>
  );
}
