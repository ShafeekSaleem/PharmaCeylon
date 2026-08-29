import { apiJson } from "@/lib/auth-client";
import type { MyProfile } from "./types";

export function fetchMyProfile(): Promise<MyProfile> {
  return apiJson<MyProfile>("/auth/me/profile");
}

export function saveMyProfile(input: { fullName: string; phone: string | null }): Promise<MyProfile> {
  return apiJson<MyProfile>("/auth/me/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function removeMyAvatar(): Promise<void> {
  return apiJson<void>("/auth/me/avatar", { method: "DELETE" });
}
