import { apiJson } from "@/lib/auth-client";
import type { Branch, CreateBranchInput, UpdateBranchInput } from "./types";

export function fetchAllBranches(): Promise<Branch[]> {
  return apiJson<Branch[]>("/tenant/branches/all");
}

export function createBranch(input: CreateBranchInput): Promise<Branch> {
  return apiJson<Branch>("/tenant/branches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateBranch(branchId: string, input: UpdateBranchInput): Promise<Branch> {
  return apiJson<Branch>(`/tenant/branches/${branchId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
