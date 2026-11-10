import type {
  ApproveJournalRecoveryRequest,
  MissingJournalSignOffRequest,
  OfflineJournalRecoveriesView,
  OfflineJournalRecoveryView,
} from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";

// Pin the branch on every request, including retries after an auth refresh.
export function journalRecoveryApi(branchId: string) {
  const headers = { "x-branch-id": branchId };
  const post = (path: string, body: unknown) =>
    apiJson<OfflineJournalRecoveryView>(`/offline-journal-recoveries/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return {
    list: () =>
      apiJson<OfflineJournalRecoveriesView>("/offline-journal-recoveries", {
        headers,
      }),
    detail: (recoveryId: string) =>
      apiJson<OfflineJournalRecoveryView>(
        `/offline-journal-recoveries/${recoveryId}`,
        { headers },
      ),
    approve: (recoveryId: string, body: ApproveJournalRecoveryRequest) =>
      post(`${recoveryId}/approve`, body),
    signOff: (body: MissingJournalSignOffRequest) =>
      post("missing-journal", body),
  };
}
