import type {
  CounterJournalSyncStatus,
  TerminalCounterView,
  TerminalEnrollmentCodeIssued,
  TerminalEnrollmentCodeView,
} from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Every call is scoped to the selected branch by the `x-branch-id` header `apiJson` adds. */
export const countersApi = {
  /** Counters in use; `includeInactive` also lists the ones the pharmacy has stopped using. */
  counters: (includeInactive = false) =>
    apiJson<TerminalCounterView[]>(
      includeInactive ? "/terminals/counters?includeInactive=true" : "/terminals/counters",
    ),
  /** P5 #51: how far each counter's offline journal has reached the server, with the branch's timezone. */
  journalStatus: () => apiJson<CounterJournalSyncStatus>("/terminals/offline-journal/sync-status"),
  createCounter: (label: string) =>
    apiJson<TerminalCounterView>("/terminals/counters", json({ label })),
  updateCounter: (registerId: string, changes: { label?: string; isActive?: boolean }) =>
    apiJson<TerminalCounterView>(`/terminals/counters/${registerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    }),
  deleteCounter: (registerId: string) =>
    apiJson<void>(`/terminals/counters/${registerId}`, { method: "DELETE" }),
  codes: () => apiJson<TerminalEnrollmentCodeView[]>("/terminals/enrollment-codes"),
  issueCode: (registerId: string, expiresInMinutes: number) =>
    apiJson<TerminalEnrollmentCodeIssued>(
      "/terminals/enrollment-codes",
      json({ registerId, expiresInMinutes }),
    ),
  revokeCode: (codeId: string) =>
    apiJson<TerminalEnrollmentCodeView>(`/terminals/enrollment-codes/${codeId}/revoke`, {
      method: "POST",
    }),
  /** Report lost or stolen: the key stops working at once; the counter can enroll again. */
  revokeEnrollment: (enrollmentId: string, reason: string) =>
    apiJson<void>(`/terminals/enrollments/${enrollmentId}/revoke`, json({ reason })),
  /** The computer leaves service for good and frees its counter. */
  retireDevice: (terminalId: string, reason: string) =>
    apiJson<void>(`/terminals/devices/${terminalId}/retire`, json({ reason })),
};
