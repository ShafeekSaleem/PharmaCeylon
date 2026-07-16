"use client";

import { AppShell } from "@/components/app-shell/app-shell";
import { FloatingTooltipHost } from "@/components/ui/floating-tooltip";
import { PageChromeProvider } from "@/lib/page-chrome-context";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PageChromeProvider>
      <AppShell>{children}</AppShell>
      <FloatingTooltipHost />
    </PageChromeProvider>
  );
}
