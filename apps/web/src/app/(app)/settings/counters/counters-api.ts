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
  counters: () => apiJson<TerminalCounterView[]>("/terminals/counters"),
  /** P5 #51: how far each counter's offline journal has reached the server, with the branch's timezone. */
  journalStatus: () => apiJson<CounterJournalSyncStatus>("/terminals/offline-journal/sync-status"),
  createCounter: (label: string) =>
    apiJson<TerminalCounterView>("/terminals/counters", json({ label })),
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
