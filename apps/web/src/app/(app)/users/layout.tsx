"use client";

import { usePathname } from "next/navigation";
import { UsersSubnav } from "./components/users-subnav";
import css from "./users.module.css";

export default function UsersLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className={css.page}>
      <UsersSubnav />
      <div key={pathname} className={css.sectionContent}>
        {children}
      </div>
    </div>
  );
}
