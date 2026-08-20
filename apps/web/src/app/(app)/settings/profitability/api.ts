import { apiJson } from "@/lib/auth-client";

export type ProfitabilityTargetSettings = { targetGrossMarginPercent: number | null };

export function fetchProfitabilityTargetSetting(): Promise<ProfitabilityTargetSettings> {
  return apiJson<ProfitabilityTargetSettings>("/tenant/profitability-target");
}

export function saveProfitabilityTargetSetting(
  targetGrossMarginPercent: number | null,
): Promise<ProfitabilityTargetSettings> {
  return apiJson<ProfitabilityTargetSettings>("/tenant/profitability-target", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetGrossMarginPercent }),
  });
}
