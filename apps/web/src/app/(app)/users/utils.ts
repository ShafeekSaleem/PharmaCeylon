import { ROLE_LABELS } from "./constants";
import type { BranchRoleMapping } from "./types";

/** Custom-role mappings carry their live name via `roleRef`; built-ins use the static label. */
export function roleDisplayName(mapping: BranchRoleMapping): string {
  return mapping.roleRef?.name ?? ROLE_LABELS[mapping.role];
}

export function staffInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Random 12-char temp password: upper, lower, digit, symbol guaranteed, rest shuffled. */
export function generateTempPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*";
  const all = upper + lower + digits + symbols;

  const pick = (pool: string) => pool[Math.floor(Math.random() * pool.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < 12) chars.push(pick(all));

  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Best-effort "Browser · OS" label from a raw User-Agent string. */
export function formatUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";

  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /chrome\//i.test(ua)
      ? "Chrome"
      : /firefox\//i.test(ua)
        ? "Firefox"
        : /safari\//i.test(ua)
          ? "Safari"
          : "Browser";

  const os = /iphone|ipad/i.test(ua)
    ? "iOS"
    : /android/i.test(ua)
      ? "Android"
      : /windows/i.test(ua)
        ? "Windows"
        : /mac os/i.test(ua)
          ? "macOS"
          : /linux/i.test(ua)
            ? "Linux"
            : null;

  return os ? `${browser} · ${os}` : browser;
}
