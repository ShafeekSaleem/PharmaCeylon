import { apiJson } from "@/lib/auth-client";

export type NmraLinkEvidence =
  | "barcode"
  | "registration"
  | "name"
  | "normalized"
  | "fuzzy"
  | "inn_head";

export type NmraLinkCandidate = {
  product: {
    id: string;
    name: string;
    brandName: string | null;
    genericName: string | null;
    strength: string | null;
    dosageForm: string | null;
    registrationNo: string | null;
    isControlled: boolean;
    requiresPrescription: boolean;
  };
  evidence: NmraLinkEvidence;
  needsComplianceConfirmation: boolean;
};

export type NmraLinkFieldChange = {
  field: string;
  from: string | boolean | null;
  to: string | boolean | null;
  changed: boolean;
  adoptable: boolean;
};

export type NmraLinkPreview = {
  plan: {
    updates: Record<string, string | boolean | null>;
    changes: NmraLinkFieldChange[];
    complianceStatements: string[];
    aliasesToAdd: Array<{ aliasText: string; aliasType: "shop_name" | "shop_brand" | "barcode" }>;
  };
  regulatoryCategories: Array<{ dimension: string; categoryId: string; categoryName: string }>;
  commercialCategory: { willAdopt: boolean; categoryId: string | null; categoryName: string | null } | null;
  tagsToMerge: Array<{ id: string; name: string }>;
  reference: { id: string; name: string; brandName: string | null; registrationNo: string | null };
};

export function fetchNmraLinkCandidates(productId: string): Promise<NmraLinkCandidate[]> {
  return apiJson<NmraLinkCandidate[]>(`/products/${productId}/nmra-link/candidates`);
}

export type NmraLinkQueueItem = {
  product: { id: string; name: string; brandName: string | null };
  candidates: NmraLinkCandidate[];
};

export function fetchNmraLinkQueue(
  take = 50,
): Promise<{ items: NmraLinkQueueItem[]; total: number }> {
  return apiJson<{ items: NmraLinkQueueItem[]; total: number }>(
    `/products/nmra-link/unlinked?take=${take}`,
  );
}

export type NmraBulkLinkResult = {
  linked: string[];
  held: Array<{ productId: string; reason: string }>;
  failed: Array<{ productId: string; reason: string }>;
};

export function bulkApplyNmraLinks(
  links: Array<{ productId: string; referenceProductId: string }>,
): Promise<NmraBulkLinkResult> {
  return apiJson<NmraBulkLinkResult>("/products/nmra-link/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ links }),
  });
}

export function previewNmraLink(
  productId: string,
  referenceProductId: string,
  adoptFieldOverrides?: string[],
): Promise<NmraLinkPreview> {
  return apiJson<NmraLinkPreview>(`/products/${productId}/nmra-link/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ referenceProductId, adoptFieldOverrides }),
  });
}

export function applyNmraLink(
  productId: string,
  referenceProductId: string,
  adoptFieldOverrides?: string[],
) {
  return apiJson(`/products/${productId}/nmra-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ referenceProductId, adoptFieldOverrides }),
  });
}

export function unlinkNmraLink(productId: string) {
  return apiJson(`/products/${productId}/nmra-link`, { method: "DELETE" });
}
