/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createRef } from "react";
import { ids, renderWithKeys, stubPos } from "../test/harness";
import { PrescriptionSheet } from "./Dispensing";
import { KeyScope } from "./keymap";

const recorded = {
  prescriptionId: "00000000-0000-4000-8000-0000000000f1",
  rxNumber: "RX-00042",
  patientName: "Nimal Perera",
  doctorName: "Dr Silva",
  issuedOn: "2026-11-04",
  validUntil: null,
  expired: false,
  customerId: null,
  customerName: null,
};

let pos: Record<string, jest.Mock>;
let onPrescription: jest.Mock;

beforeEach(() => {
  pos = stubPos({
    listApprovers: async () => ({
      ok: true,
      value: [{ userId: ids.ben, fullName: "Dilshan Wickramasinghe", hasPin: true }],
    }),
  });
  onPrescription = jest.fn();
});
afterEach(cleanup);

async function renderSheet() {
  renderWithKeys(
    <KeyScope active>
      <PrescriptionSheet
        rxLines={[{ productId: ids.ana, name: "Amoxicillin 500mg Capsules", qty: 21, unit: "caps" }]}
        hasControlled={false}
        customer={null}
        prescription={null}
        approverId=""
        pin=""
        refusal={null}
        refusedApproverIds={[]}
        pinRef={createRef<HTMLInputElement>()}
        totalText="2,718.50"
        onPrescription={onPrescription}
        onApprover={() => undefined}
        onPin={() => undefined}
        onHold={() => undefined}
        onClose={() => undefined}
        onContinue={() => undefined}
      />
    </KeyScope>,
  );
  await act(async () => undefined);
  fireEvent.change(screen.getByLabelText("Patient"), { target: { value: "Nimal Perera" } });
  fireEvent.change(screen.getByLabelText("Doctor"), { target: { value: "Dr Silva" } });
}

const save = async (name: RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

describe("recording a prescription at the counter", () => {
  it("records with a registered pharmacist's PIN, sent once with the details and then cleared", async () => {
    pos.recordPrescription = jest.fn(async () => ({ ok: true, value: recorded }));
    await renderSheet();
    fireEvent.click(screen.getByRole("button", { name: /Dilshan Wickramasinghe/ }));
    const save_ = screen.getByRole("button", { name: /Co-sign and save/ });
    expect(save_).toHaveProperty("disabled", true);
    const pin = screen.getByLabelText("Dilshan Wickramasinghe's PIN to record the prescription") as HTMLInputElement;
    fireEvent.change(pin, { target: { value: "73a5190" } });
    expect(pin.value).toBe("735190");
    await save(/Co-sign and save/);
    expect(pos.recordPrescription).toHaveBeenCalledWith(
      expect.objectContaining({
        patientName: "Nimal Perera",
        doctorName: "Dr Silva",
        coSign: { approverUserId: ids.ben, pin: "735190" },
      }),
    );
    expect(onPrescription).toHaveBeenCalledWith(recorded);
  });

  it("records as the signed-in person by default, with no co-sign", async () => {
    pos.recordPrescription = jest.fn(async () => ({ ok: true, value: recorded }));
    await renderSheet();
    await save(/Save prescription/);
    expect(pos.recordPrescription.mock.calls[0]![0]).not.toHaveProperty("coSign");
  });

  it("explains PHARMACIST_REQUIRED and offers a pharmacist's co-sign or a hold", async () => {
    pos.recordPrescription = jest.fn(async () => ({
      ok: false,
      error: { code: "PHARMACIST_REQUIRED", message: "Recording a prescription needs a pharmacist." },
    }));
    await renderSheet();
    await save(/Save prescription/);
    expect(screen.getByRole("alert").textContent).toMatch(/ask for their PIN/);
    fireEvent.click(screen.getByRole("button", { name: "Choose a pharmacist" }));
    expect(document.activeElement?.textContent).toMatch(/Dilshan Wickramasinghe/);
    expect(screen.getByRole("button", { name: /Hold this sale/ })).toBeTruthy();
  });

  it("marks a co-signer without a registration, and asks for the PIN again after any refusal", async () => {
    pos.recordPrescription = jest.fn(async () => ({
      ok: false,
      error: { code: "APPROVER_NOT_QUALIFIED", message: "This pharmacist can't co-sign the prescription." },
    }));
    await renderSheet();
    fireEvent.click(screen.getByRole("button", { name: /Dilshan Wickramasinghe/ }));
    fireEvent.change(screen.getByLabelText(/PIN to record/), { target: { value: "1234" } });
    await save(/Co-sign and save/);
    expect(screen.getByRole("alert").textContent).toMatch(/can't co-sign the prescription/);
    expect(screen.getByText("No current SLMC registration at this branch")).toBeTruthy();
    expect((screen.getByLabelText(/PIN to record/) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: /Co-sign and save/ })).toHaveProperty("disabled", true);
  });
});
