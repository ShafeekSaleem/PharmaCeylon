import { apiJson } from "@/lib/auth-client";
import type { TenantProfile, UpdateTenantProfileInput } from "./types";

export function fetchTenantProfile(): Promise<TenantProfile> {
  return apiJson<TenantProfile>("/tenant/profile");
}

export function saveTenantProfile(input: UpdateTenantProfileInput): Promise<TenantProfile> {
  return apiJson<TenantProfile>("/tenant/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
