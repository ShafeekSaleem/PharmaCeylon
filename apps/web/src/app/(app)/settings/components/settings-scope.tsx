"use client";

import { usePathname } from "next/navigation";
import css from "../settings.module.css";

type Scope = { label: string; description: string };

function resolveScope(pathname: string): Scope {
  if (pathname === "/settings/my-profile" || pathname === "/settings/appearance") {
    return {
      label: "Personal",
      description: "These changes affect only your account.",
    };
  }
  if (pathname === "/settings/password-login") {
    return {
      label: "Account & organization",
      description: "Your password is personal; password policy applies to all staff.",
    };
  }
  if (pathname === "/settings/branches") {
    return {
      label: "Organization structure",
      description: "Branch records affect staff access, stock and documents.",
    };
  }
  return {
    label: "Organization-wide",
    description: "These changes apply across every branch unless a field says otherwise.",
  };
}

export function SettingsScope() {
  const scope = resolveScope(usePathname());
  return (
    <div className={css.scopeBar} role="note">
      <span className={css.scopeBadge}>{scope.label}</span>
      <span>{scope.description}</span>
    </div>
  );
}
