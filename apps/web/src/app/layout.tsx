import type { Metadata } from "next";
import "./globals.css";
import { APP_NAME } from "@pharmaceylon/shared";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
