"use client";

import { PageSubnav, type PageSubnavTab } from "@/components/ui";

const TABS: PageSubnavTab[] = [
  { href: "/users", label: "Staff", match: (p) => p === "/users" },
  { href: "/users/roles", label: "Roles & permissions" },
];

export function UsersSubnav() {
  return <PageSubnav label="Users sections" tabs={TABS} />;
}
