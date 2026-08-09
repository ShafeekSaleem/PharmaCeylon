export type HealthTone = "success" | "warning" | "danger";

/** Risk-weighted score from low/dead/near-expiry counts only — fast movers is
 * a volume metric, not a risk signal, so it's surfaced separately alongside it. */
export function inventoryHealthScore(input: {
  low: number;
  dead: number;
  nearExpiry: number;
  fast: number;
}): { score: number; tone: HealthTone; label: string } {
  const risk = input.low * 3 + input.dead * 1 + input.nearExpiry * 2;
  const boost = Math.min(12, input.fast * 0.15);
  const score = Math.round(
    Math.max(0, Math.min(100, 100 - Math.min(72, risk * 0.75) + boost)),
  );
  if (score >= 70) return { score, tone: "success", label: "Good" };
  if (score >= 45) return { score, tone: "warning", label: "Fair" };
  return { score, tone: "danger", label: "Critical" };
}
