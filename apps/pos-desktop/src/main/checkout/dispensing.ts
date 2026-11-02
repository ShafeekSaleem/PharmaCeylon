import type {
  ApproverView,
  CustomerView,
  PrescriptionView,
  RecordPrescription,
} from "../../shared/ipc-contract";
import type { ApiSession } from "../api/api-client";
import {
  ActionFailure,
  type TerminalService,
} from "../terminal/terminal-service";

type RawCustomer = { id: string; fullName: string; phone: string | null };

type RawPrescription = {
  id: string;
  rxNumber: string;
  patientName: string;
  doctorName: string;
  issuedOn: string;
  validUntil: string | null;
  customerId: string | null;
  customer: { fullName: string } | null;
};

type RawApprover = { id: string; fullName: string; hasPosPin: boolean };

const day = (iso: string) => iso.slice(0, 10);

/** Same boundary as the server: a prescription lapses at the start of the UTC day after validUntil. */
export function toPrescription(raw: RawPrescription, now: Date): PrescriptionView {
  const today = now.toISOString().slice(0, 10);
  return {
    prescriptionId: raw.id,
    rxNumber: raw.rxNumber,
    patientName: raw.patientName,
    doctorName: raw.doctorName,
    issuedOn: day(raw.issuedOn),
    validUntil: raw.validUntil ? day(raw.validUntil) : null,
    expired: raw.validUntil !== null && day(raw.validUntil) < today,
    customerId: raw.customerId,
    customerName: raw.customer?.fullName ?? null,
  };
}

export const toCustomer = (raw: RawCustomer): CustomerView => ({
  customerId: raw.id,
  fullName: raw.fullName,
  phone: raw.phone,
});

/**
 * Prescription capture and co-sign lookups for checkout at the counter. Everything goes to the
 * server as the signed-in person: recording a prescription needs `prescriptions.create`, and the
 * checkout itself decides who may dispense controlled items and verifies the co-signer's PIN.
 * Nothing here is cached on disk; patient details stay on the server.
 */
export class DispensingService {
  constructor(
    private readonly deps: {
      api: ApiSession;
      terminal: TerminalService;
      now?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private branchId() {
    const current = this.deps.terminal.current();
    if (!current)
      throw new ActionFailure(
        "NOT_SIGNED_IN",
        "Sign in at this counter first.",
      );
    return current.identity.branchId;
  }

  async customers(q: string): Promise<CustomerView[]> {
    const branchId = this.branchId();
    const rows = await this.deps.api.request<RawCustomer[]>(
      "GET",
      `/customers?${new URLSearchParams({ q, take: "20" })}`,
      { branchId },
    );
    return rows.map(toCustomer);
  }

  async customer(customerId: string): Promise<CustomerView> {
    const branchId = this.branchId();
    return toCustomer(
      await this.deps.api.request<RawCustomer>(
        "GET",
        `/customers/${customerId}`,
        { branchId },
      ),
    );
  }

  async prescriptions(filter: {
    q?: string;
    customerId?: string;
  }): Promise<PrescriptionView[]> {
    const branchId = this.branchId();
    const params = new URLSearchParams({ take: "20" });
    if (filter.q) params.set("q", filter.q);
    if (filter.customerId) params.set("customerId", filter.customerId);
    const rows = await this.deps.api.request<RawPrescription[]>(
      "GET",
      `/prescriptions?${params}`,
      { branchId },
    );
    const now = this.now();
    return rows.map((r) => toPrescription(r, now));
  }

  async prescription(prescriptionId: string): Promise<PrescriptionView> {
    const branchId = this.branchId();
    return toPrescription(
      await this.deps.api.request<RawPrescription>(
        "GET",
        `/prescriptions/${prescriptionId}`,
        { branchId },
      ),
      this.now(),
    );
  }

  async record(input: RecordPrescription): Promise<PrescriptionView> {
    const branchId = this.branchId();
    const raw = await this.deps.api.request<RawPrescription>(
      "POST",
      "/prescriptions",
      { branchId, body: input },
    );
    return toPrescription(raw, this.now());
  }

  async approvers(): Promise<ApproverView[]> {
    const branchId = this.branchId();
    const rows = await this.deps.api.request<RawApprover[]>(
      "GET",
      "/sales/pos/approvers",
      { branchId },
    );
    return rows.map((r) => ({
      userId: r.id,
      fullName: r.fullName,
      hasPin: r.hasPosPin,
    }));
  }
}
