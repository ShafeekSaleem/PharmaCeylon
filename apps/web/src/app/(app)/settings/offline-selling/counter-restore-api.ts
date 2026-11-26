import type {
  AcknowledgeCounterRestoreRequest,
  OfflineCounterRestoresView,
  OfflineCounterRestoreView,
} from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";

// Pin the branch on every request, including retries after an auth refresh.
export function counterRestoreApi(branchId: string) {
  const headers = { "x-branch-id": branchId };
  return {
    list: () =>
      apiJson<OfflineCounterRestoresView>("/offline-counter-restores", {
        headers,
      }),
    acknowledge: (id: string, body: AcknowledgeCounterRestoreRequest) =>
      apiJson<OfflineCounterRestoreView>(
        `/offline-counter-restores/${id}/acknowledge`,
        { method: "POST", headers, body: JSON.stringify(body) },
      ),
  };
}
