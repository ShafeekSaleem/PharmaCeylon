"use client";
import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";

export default function SaleDetailLayout({ children }: { children: ReactNode }) {
  return <RolePageGuard permissions={["sales.view"]}>{children}</RolePageGuard>;
}
