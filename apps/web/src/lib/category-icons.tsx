import type { ComponentType } from "react";
import {
  IconActivity,
  IconBaby,
  IconCoffee,
  IconDroplet,
  IconFirstAid,
  IconGrid,
  IconHome,
  IconLeaf,
  IconPill,
  IconSparkles,
  IconStethoscope,
  type IconProps,
} from "@/components/icons";

export type CategoryVisual = {
  Icon: ComponentType<IconProps>;
  /** Soft tinted badge background. */
  bg: string;
  /** Icon (and text, where used standalone) color — the saturated half of the tint. */
  fg: string;
};

const DEFAULT_VISUAL: CategoryVisual = {
  Icon: IconGrid,
  bg: "var(--pc-muted-bg)",
  fg: "var(--pc-muted-fg)",
};

/**
 * Icon + color badge per top-level COMMERCIAL department — the same department set every
 * Reports page rolls sub-categories up to (see `CategoryTaxonomyService.primaryCommercialCategoryByProductIds`
 * on the API side). Keyed by `canonicalKey` from `commercial-category-template.ts`, the stable
 * identity for these seeded departments — a tenant may rename the display `name`, so matching on
 * name alone would silently lose the icon the moment someone does. `getCategoryVisual` falls back
 * to matching the (English, seeded-default) name for callers that only have the display string,
 * then to a generic grid icon for tenant-created custom categories this list doesn't know about.
 *
 * One canonical set used everywhere a Commercial Category shows up as a column/label — don't
 * invent a page-local variant; import `getCategoryVisual`/`CategoryBadge` from here instead.
 */
const CATEGORY_VISUALS: Record<string, CategoryVisual> = {
  MEDICINES: { Icon: IconPill, bg: "color-mix(in srgb, var(--pc-tone-success) 16%, #fff)", fg: "var(--pc-tone-success-strong)" },
  VITAMINS_SUPPLEMENTS: { Icon: IconLeaf, bg: "color-mix(in srgb, var(--pc-secondary-cyan) 16%, #fff)", fg: "var(--pc-secondary-cyan)" },
  BABY_CARE: { Icon: IconBaby, bg: "color-mix(in srgb, #ec4899 16%, #fff)", fg: "#db2777" },
  PERSONAL_CARE: { Icon: IconSparkles, bg: "color-mix(in srgb, var(--pc-tone-violet) 14%, #fff)", fg: "var(--pc-tone-violet-strong)" },
  BEAUTY_SKIN_CARE: { Icon: IconDroplet, bg: "color-mix(in srgb, #c026d3 15%, #fff)", fg: "#a21caf" },
  MEDICAL_DEVICES: { Icon: IconStethoscope, bg: "color-mix(in srgb, var(--pc-tone-blue) 14%, #fff)", fg: "var(--pc-tone-blue-strong)" },
  FIRST_AID: { Icon: IconFirstAid, bg: "color-mix(in srgb, var(--pc-tone-danger) 13%, #fff)", fg: "var(--pc-tone-danger-strong)" },
  NUTRITION_WELLNESS: { Icon: IconActivity, bg: "color-mix(in srgb, var(--pc-tone-emerald) 15%, #fff)", fg: "var(--pc-tone-emerald-strong)" },
  FOOD_BEVERAGE: { Icon: IconCoffee, bg: "color-mix(in srgb, var(--pc-tone-warning) 15%, #fff)", fg: "var(--pc-tone-warning-strong)" },
  HOUSEHOLD_CONVENIENCE: { Icon: IconHome, bg: "var(--pc-muted-bg)", fg: "var(--pc-muted-fg)" },
  OTHER: DEFAULT_VISUAL,
};

const NAME_TO_KEY: Record<string, keyof typeof CATEGORY_VISUALS> = {
  "medicines": "MEDICINES",
  "vitamins & supplements": "VITAMINS_SUPPLEMENTS",
  "baby & mother care": "BABY_CARE",
  "personal care": "PERSONAL_CARE",
  "beauty & skin care": "BEAUTY_SKIN_CARE",
  "medical devices": "MEDICAL_DEVICES",
  "first aid": "FIRST_AID",
  "nutrition & wellness": "NUTRITION_WELLNESS",
  "food & beverages": "FOOD_BEVERAGE",
  "household & convenience": "HOUSEHOLD_CONVENIENCE",
  "other": "OTHER",
  "unclassified": "OTHER",
};

export function getCategoryVisual(canonicalKey?: string | null, name?: string | null): CategoryVisual {
  if (canonicalKey && CATEGORY_VISUALS[canonicalKey]) return CATEGORY_VISUALS[canonicalKey];
  const key = NAME_TO_KEY[(name ?? "").trim().toLowerCase()];
  return key ? CATEGORY_VISUALS[key] : DEFAULT_VISUAL;
}

export type StatIconTone = "primary" | "success" | "warning" | "danger" | "info";

/**
 * Closest fit among `StatCard`'s five fixed icon tones (it has no arbitrary-color option) for a
 * department, so a "Medicines" driver card is always green and a "First Aid" one is always red —
 * deterministic per category instead of cycling by rank/position, which used to reassign a
 * category's tone every time the ranking reshuffled.
 */
const CATEGORY_STAT_TONE: Record<string, StatIconTone> = {
  MEDICINES: "success",
  NUTRITION_WELLNESS: "success",
  VITAMINS_SUPPLEMENTS: "info",
  MEDICAL_DEVICES: "info",
  FOOD_BEVERAGE: "warning",
  FIRST_AID: "danger",
  BABY_CARE: "primary",
  PERSONAL_CARE: "primary",
  BEAUTY_SKIN_CARE: "primary",
  HOUSEHOLD_CONVENIENCE: "primary",
  OTHER: "primary",
};

export function getCategoryStatTone(canonicalKey?: string | null, name?: string | null): StatIconTone {
  if (canonicalKey && CATEGORY_STAT_TONE[canonicalKey]) return CATEGORY_STAT_TONE[canonicalKey]!;
  const key = NAME_TO_KEY[(name ?? "").trim().toLowerCase()];
  return key ? CATEGORY_STAT_TONE[key]! : "primary";
}

type BadgeProps = {
  canonicalKey?: string | null;
  name?: string | null;
  size?: number;
  className?: string;
};

/** Small rounded, tinted icon square for a Commercial Category — the standard way this app
 *  identifies a category at a glance in a table cell or list row. Pair with the plain name text
 *  next to it; this renders only the icon square. */
export function CategoryIconBadge({ canonicalKey, name, size = 24, className }: BadgeProps) {
  const { Icon, bg, fg } = getCategoryVisual(canonicalKey, name);
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.32),
        background: bg,
        color: fg,
        flexShrink: 0,
      }}
    >
      <Icon size={Math.round(size * 0.56)} />
    </span>
  );
}
