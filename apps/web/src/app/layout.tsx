import type { Metadata } from "next";
import "./globals.css";
import { APP_NAME } from "@pharmaceylon/shared";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/appearance";
import { BRAND_BOOTSTRAP_SCRIPT } from "@/lib/pharmacy-brand";

export const metadata: Metadata = {
  title: `${APP_NAME} — Pharmacy operations platform`,
  description: "PharmaCeylon helps pharmacies run POS, inventory, and multi-branch operations.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Must run before first paint — see THEME_BOOTSTRAP_SCRIPT. Applying the
            theme in React instead means a dark-mode viewer gets a white flash on
            every cold load. */}
        <script
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
        {/* The pharmacy brand last seen in this browser (UI1 #205), for the same reason. */}
        <script
          dangerouslySetInnerHTML={{ __html: BRAND_BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
