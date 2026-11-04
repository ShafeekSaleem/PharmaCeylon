import type { PharmacistCosign } from "@pharmaceylon/shared";
import type {
  ApproverView,
  CustomerView,
  PrescriptionView,
  RecordPrescription,
} from "../../shared/ipc-contract";
import { ApiError, type ApiSession } from "../api/api-client";
import type { SignedCommandService } from "../terminal/signed-commands";
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

/** The signed command's refusals, said for a prescription at the counter. */
function recordRefusal(error: unknown): unknown {
  // The server's own message is the generic "Terminal authorization failed".
  if (error instanceof ApiError && error.code === "PHARMACIST_REQUIRED")
    return new ActionFailure(
      "PHARMACIST_REQUIRED",
      "Recording a prescription needs a pharmacist with a current SLMC registration at this branch. Choose them and ask for their PIN, or ask them to switch in at this counter and record it.",
    );
  if (error instanceof ApiError && error.code === "APPROVER_NOT_QUALIFIED")
    return new ActionFailure(
      "APPROVER_NOT_QUALIFIED",
      "This pharmacist has no current SLMC registration at this branch, so they can't co-sign the prescription. Nothing was saved.",
    );
  // Spent, expired or for different details: a fresh co-sign is asked for, never reused.
  if (error instanceof ApiError && error.code === "COSIGN_INVALID")
    return new ActionFailure(
      "COSIGN_INVALID",
      "The pharmacist's co-sign has expired or was for different details. Ask for their PIN again. Nothing was saved.",
    );
  // Without a signed-in counter session, a cashier recording alone is refused the grant.
  if (error instanceof ApiError && error.code === "PERMISSION_DENIED")
    return new ActionFailure(
      "PERMISSION_DENIED",
      "You can't record prescriptions yourself. Choose a registered pharmacist and ask for their PIN.",
    );
  if (error instanceof ActionFailure && error.code === "COMMAND_UNCERTAIN")
    return new ActionFailure(
      "COMMAND_UNCERTAIN",
      "The server did not answer, so the prescription may have been saved. Confirm the unconfirmed action, then search for the prescription instead of recording it again.",
    );
  return error;
}

/**
 * Prescription capture and co-sign lookups for checkout at the counter. Everything goes to the
 * server as the signed-in person. Recording a prescription is a signed clinical command: the
 * signed-in person needs `prescriptions.create` and a current SLMC registration at the branch.
 * The checkout itself decides who may dispense controlled items and verifies the co-signer's PIN
 * and registration. Nothing here is cached on disk; patient details stay on the server (the
 * signed envelope kept until its receipt arrives is the exception).
 */
export class DispensingService {
  constructor(
    private readonly deps: {
      api: ApiSession;
      terminal: TerminalService;
      commands: SignedCommandService;
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

  /**
   * Signed, so the server checks an SLMC registration (P1 #47): the signed-in person's own, or with
   * `coSign` a registered pharmacist's. Their PIN goes once to the server, which checks it and issues
   * a single-use co-sign for exactly this prescription; the signed command carries only its ID.
   * The PIN is not kept, signed or logged.
   */
  async record(input: RecordPrescription): Promise<PrescriptionView> {
    // The adapter takes every key, trimmed text, and null rather than blank.
    const text = (value: string | undefined) => value?.trim() || null;
    const body = {
      rxNumber: null,
      patientName: input.patientName.trim(),
      doctorName: input.doctorName.trim(),
      doctorRegNo: text(input.doctorRegNo),
      issuedOn: input.issuedOn,
      validUntil: input.validUntil ?? null,
      customerId: input.customerId ?? null,
      notes: text(input.notes),
    };
    const operation = "POST /api/v1/prescriptions" as const;
    const { result } = await (async () => {
      let pharmacistEvidenceId: string | null = null;
      if (input.coSign) {
        const current = this.deps.terminal.current();
        if (!current)
          throw new ActionFailure("NOT_SIGNED_IN", "Sign in at this counter first.");
        const cosign = await this.deps.api.request<PharmacistCosign>(
          "POST",
          "/terminal-commands/pharmacist-cosigns",
          {
            branchId: current.identity.branchId,
            body: {
              workSessionId: current.staff.workSessionId,
              operation,
              body,
              pharmacistUserId: input.coSign.approverUserId,
              pin: input.coSign.pin,
            },
          },
        );
        pharmacistEvidenceId = cosign.pharmacistEvidenceId;
      }
      return this.deps.commands.execute(operation, body, null, pharmacistEvidenceId);
    })().catch((error: unknown) => {
      throw recordRefusal(error);
    });
    // The receipt carries ids only; the rest is what was signed.
    return toPrescription(
      {
        id: result.prescriptionId,
        rxNumber: result.rxNumber,
        patientName: body.patientName,
        doctorName: body.doctorName,
        issuedOn: body.issuedOn,
        validUntil: body.validUntil,
        customerId: body.customerId,
        customer: null,
      },
      this.now(),
    );
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
