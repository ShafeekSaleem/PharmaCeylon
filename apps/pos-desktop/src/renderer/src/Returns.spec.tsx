/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type {
  RefundAtCounter,
  ReturnSale,
  SaleFound,
} from "../../shared/ipc-contract";
import { press, renderWithKeys, stubPos } from "../test/harness";
import { KeyScope } from "./keymap";
import { Returns } from "./Returns";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const sale: ReturnSale = {
  saleId: id(1),
  invoiceNo: "INV-T1-1029-0188",
  status: "partially_refunded",
  soldAt: "2026-10-29T11:12:00.000Z",
  grandTotal: "6992.00",
  sellerName: "Kasun J.",
  customer: { fullName: "Ruwan Jayawardena", phone: "071 482 0937" },
  payments: [{ method: "card", amount: "6992.00", reference: "Visa •• 4417" }],
  needsPharmacist: true,
  refundLimit: "5000.00",
  earlierRefunds: [{ returnNumber: "RET-1", amount: "192.00", createdAt: "2026-10-30T05:00:00.000Z" }],
  lines: [
    {
      productId: id(11), batchId: id(21), name: "Accu-Chek Active Strips ×50", sku: "ACA", batchNo: "ACA-2210",
      expiryDate: "2027-05-31", unit: "box", soldQty: 1, remainingQty: 1, paidTotal: "4850.00",
      isControlled: false, requiresPrescription: false,
    },
    {
      productId: id(12), batchId: id(22), name: "Softclix Lancets ×25", sku: "SCL", batchNo: "SCL-0874",
      expiryDate: "2028-09-30", unit: "box", soldQty: 1, remainingQty: 1, paidTotal: "1450.00",
      isControlled: false, requiresPrescription: false,
    },
    {
      productId: id(13), batchId: id(23), name: "Losartan 50mg Tablets", sku: "LS", batchNo: "LS-4410",
      expiryDate: "2028-01-31", unit: "tabs", soldQty: 30, remainingQty: 30, paidTotal: "300.00",
      isControlled: false, requiresPrescription: true,
    },
    {
      productId: id(14), batchId: id(24), name: "Panadol 500mg Tablets", sku: "PAN", batchNo: "PN-1",
      expiryDate: "2027-01-31", unit: "strips", soldQty: 2, remainingQty: 0, paidTotal: "192.00",
      isControlled: false, requiresPrescription: false,
    },
  ],
};

const found: SaleFound = {
  saleId: sale.saleId, invoiceNo: sale.invoiceNo, status: "posted", soldAt: sale.soldAt, grandTotal: "6992.00",
  itemCount: 34, customerName: "Ruwan Jayawardena", customerPhone: "071 482 0937", sellerName: "Kasun J.",
  paymentMethods: ["card"], summary: "1× Accu-Chek Active Strips ×50",
};

const fromWeb: RefundAtCounter = {
  refundRequestId: id(31), requestNumber: "RF-0031", invoiceNo: "INV-T1-1029-0188", amount: "1840.00",
  refundMethod: "card", reason: "Damaged", requestedBy: "Nimal P.", approvedBy: "Dilini F.", approvalEvidenceId: id(32),
};

let pos: Record<string, jest.Mock>;
let ready: RefundAtCounter[];

beforeEach(() => {
  ready = [];
  pos = stubPos({
    refundsReady: async () => ({ ok: true, value: ready }),
    returnsToday: async () => ({ ok: true, value: [] }),
    returnFindSale: async () => ({ ok: true, value: sale }),
    returnSearchSales: async () => ({ ok: true, value: [found] }),
    listRefundApprovers: async () => ({
      ok: true,
      value: [
        { userId: id(50), fullName: "Dilini Fernando", hasPin: true },
        { userId: id(51), fullName: "Owner Perera", hasPin: false },
      ],
    }),
    approveReturn: async () => ({
      ok: true,
      value: {
        status: "refunded",
        refund: {
          requestNumber: "RFR-13", amountMinor: 630000, refundedTo: [{ method: "card", amountMinor: 630000 }],
          alreadyApplied: false, requestedBy: "Sachini R.", approvedBy: "Dilini Fernando",
        },
      },
    }),
    submitReturn: async () => ({
      ok: true,
      value: {
        status: "refunded",
        refund: {
          requestNumber: "RFR-12", amountMinor: 485000, refundedTo: [{ method: "card", amountMinor: 485000 }],
          alreadyApplied: false, requestedBy: "Sachini R.", approvedBy: null,
        },
      },
    }),
    executeRefund: async () => ({
      ok: true,
      value: {
        requestNumber: "RF-0031", amountMinor: 184000, refundedTo: [{ method: "card", amountMinor: 184000 }],
        alreadyApplied: false, requestedBy: "Nimal P.", approvedBy: "Dilini F.",
      },
    }),
  });
});
afterEach(cleanup);

async function renderReturns(props: Parameters<typeof Returns>[0] = {}) {
  renderWithKeys(
    <KeyScope active>
      <Returns {...props} />
    </KeyScope>,
  );
  await act(async () => undefined);
}

async function findByInvoice(text = "INV-T1-1029-0188") {
  const field = screen.getByLabelText("Receipt barcode or invoice number");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await act(async () => undefined);
}

const row = (name: string) => screen.getByLabelText(name, { selector: "div" });

describe("Returns: finding the sale", () => {
  it("finds a sale by its invoice number and shows what can still be returned", async () => {
    await renderReturns();
    await findByInvoice(" inv-t1-1029-0188 ");

    expect(pos.returnFindSale).toHaveBeenCalledWith({ invoiceNo: "inv-t1-1029-0188" });
    const card = screen.getByLabelText("Sale found");
    expect(within(card).getByText("Kasun J.")).toBeTruthy();
    expect(within(card).getByText("Card · Visa •• 4417")).toBeTruthy();
    expect(within(card).getByText(/1 earlier, on 30 Oct/)).toBeTruthy();
    expect(within(card).getByText("071 482 0937")).toBeTruthy();
    // Panadol was refunded in full earlier: nothing left to return.
    expect(within(row("Panadol 500mg Tablets")).getByText("None left")).toBeTruthy();
    expect(within(row("Panadol 500mg Tablets")).getByText(/Refunded 30 Oct/)).toBeTruthy();
    // Nothing comes back until the cashier says so.
    expect(screen.getByText(/coming back/).textContent).toBe("0 items · 0 units coming back");
  });

  it("says why when no sale matches", async () => {
    pos.returnFindSale!.mockImplementation(async () => ({
      ok: false,
      error: { code: "SALE_NOT_FOUND", message: "No sale at this branch matches INV-404." },
    }));
    await renderReturns();
    await findByInvoice("INV-404");
    expect(screen.getByRole("alert").textContent).toContain("No sale at this branch matches INV-404.");
  });

  it("finds a sale by the customer's phone, without the receipt", async () => {
    await renderReturns();
    fireEvent.click(screen.getByRole("button", { name: "Customer phone" }));
    fireEvent.change(screen.getByLabelText("Customer's phone"), { target: { value: "071 482 0937" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await act(async () => undefined);

    expect(pos.returnSearchSales).toHaveBeenCalledWith({ customerPhone: "071 482 0937" });
    fireEvent.click(screen.getByRole("button", { name: /INV-T1-1029-0188/ }));
    await act(async () => undefined);
    expect(pos.returnFindSale).toHaveBeenCalledWith({ invoiceNo: "INV-T1-1029-0188" });
    expect(screen.getByLabelText("Sale found")).toBeTruthy();
  });

  it("finds by day, an amount about the total, how it was paid and who sold it, within a time window", async () => {
    pos.returnSearchSales!.mockImplementation(async () => ({
      ok: true,
      value: [
        found,
        { ...found, saleId: id(2), invoiceNo: "INV-LATE", soldAt: "2026-10-29T15:30:00.000Z" },
      ],
    }));
    await renderReturns();
    fireEvent.click(screen.getByRole("button", { name: "Date and amount" }));
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-10-29" } });
    fireEvent.change(screen.getByLabelText(/Total about/), { target: { value: "7000" } });
    fireEvent.change(screen.getByLabelText("Paid by"), { target: { value: "card" } });
    fireEvent.click(screen.getByLabelText("Sold by me"));
    const sold = new Date(found.soldAt);
    const hh = (h: number) => String(h).padStart(2, "0");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: `${hh(sold.getHours())}:00` } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: `${hh(sold.getHours())}:59` } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await act(async () => undefined);

    expect(pos.returnSearchSales).toHaveBeenCalledWith({
      from: "2026-10-29",
      to: "2026-10-29",
      minTotal: "6650.00",
      maxTotal: "7350.00",
      paymentMethod: "card",
      soldByMe: true,
    });
    const results = screen.getByLabelText("Sales found");
    expect(within(results).getByText("INV-T1-1029-0188")).toBeTruthy();
    expect(within(results).queryByText("INV-LATE")).toBeNull();
  });

  it("lists today's sales at this branch", async () => {
    await renderReturns();
    fireEvent.click(screen.getByRole("button", { name: "Recent at this branch" }));
    await act(async () => undefined);
    const call = pos.returnSearchSales!.mock.calls[0]![0] as { from: string; to: string };
    expect(call.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call.to).toBe(call.from);
  });
});

describe("Returns: choosing what comes back", () => {
  it("holds prescription items for inspection by default and restocks the rest", async () => {
    await renderReturns();
    await findByInvoice();

    expect(within(row("Losartan 50mg Tablets")).getByText("Quarantine if returned")).toBeTruthy();
    fireEvent.click(within(row("Losartan 50mg Tablets")).getByText("0"));
    fireEvent.click(within(row("Losartan 50mg Tablets")).getByRole("button", { name: "One more" }));
    expect(
      within(row("Losartan 50mg Tablets")).getByRole("button", { name: /Quarantine/ }).getAttribute("aria-pressed"),
    ).toBe("true");

    // The first line is selected on opening; + adds one, and it goes back on the shelf.
    fireEvent.click(row("Accu-Chek Active Strips ×50"));
    press("+");
    expect(
      within(row("Accu-Chek Active Strips ×50")).getByRole("button", { name: /Restock/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    // Q sends the selected line to quarantine instead, R puts it back.
    press("q");
    expect(
      within(row("Accu-Chek Active Strips ×50")).getByRole("button", { name: /Quarantine/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    press("r");
    expect(
      within(row("Accu-Chek Active Strips ×50")).getByRole("button", { name: /Restock/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText(/1 back on the shelf/)).toBeTruthy();
    expect(screen.getByText(/1 to quarantine, awaiting inspection/)).toBeTruthy();
  });

  it("never returns more than is left, and A takes everything still returnable", async () => {
    await renderReturns();
    await findByInvoice();
    fireEvent.click(row("Accu-Chek Active Strips ×50"));
    press("+");
    press("+");
    expect(
      (within(row("Accu-Chek Active Strips ×50")).getByRole("spinbutton") as HTMLInputElement).value,
    ).toBe("1");

    press("a");
    // 1 + 1 + 30 units; the refunded Panadol stays at none.
    expect(screen.getByText(/coming back/).textContent).toBe("3 items · 32 units coming back");
    expect(screen.getByText("6,600.00", { selector: "div" })).toBeTruthy();
  });

  it("refunds by the way the sale was paid unless cash is chosen, with the reason and note", async () => {
    await renderReturns();
    await findByInvoice();
    fireEvent.click(row("Softclix Lancets ×25"));
    press("+");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "damaged" } });
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "Box crushed" } });
    expect(screen.getByText("Back to the original card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Cash\s*From the drawer/ }));
    expect(screen.getByText("Cash from the drawer")).toBeTruthy();

    press("F12");
    await act(async () => undefined);
    expect(pos.submitReturn).toHaveBeenCalledWith({
      saleId: sale.saleId,
      lines: [{ productId: id(12), batchId: id(22), qty: 1, disposition: "restock" }],
      reasonCode: "damaged",
      note: "Box crushed",
      refundMethod: "cash",
    });
    expect(screen.getByRole("status").textContent).toContain("Refunded Rs 4,850.00");
  });

  it("asks for a note when the reason is Other", async () => {
    await renderReturns();
    await findByInvoice();
    fireEvent.click(row("Softclix Lancets ×25"));
    press("+");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "other" } });
    expect(screen.getByRole("button", { name: /Refund Rs 1,450.00/ }).hasAttribute("disabled")).toBe(true);
    press("F12");
    expect(pos.submitReturn).not.toHaveBeenCalled();
  });
});

describe("Returns: over the refund limit", () => {
  async function overTheLimit(props: Parameters<typeof Returns>[0] = {}) {
    await renderReturns(props);
    await findByInvoice();
    fireEvent.click(row("Accu-Chek Active Strips ×50"));
    press("+");
    fireEvent.click(row("Softclix Lancets ×25"));
    press("+");
    await act(async () => undefined);
  }

  it("with nobody here to co-sign, sends a cashier's refund for approval on the web", async () => {
    pos.listRefundApprovers!.mockImplementation(async () => ({ ok: true, value: [] }));
    pos.submitReturn!.mockImplementation(async () => ({
      ok: true,
      value: { status: "awaiting_approval", refundRequestId: id(40), requestNumber: "RFR-13", amount: "6300.00" },
    }));
    await overTheLimit();

    expect(screen.getByText(/Over the Rs 5,000.00 refund limit/)).toBeTruthy();
    expect(screen.getByText(/Nobody else here can approve refunds/)).toBeTruthy();
    const button = screen.getByRole("button", { name: /Send for approval/ });
    fireEvent.click(button);
    await act(async () => undefined);
    expect(pos.submitReturn).toHaveBeenCalled();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Sent for approval as RFR-13");
    expect(status.textContent).toContain("Nothing has been refunded yet");
  });

  it("lets a manager refund it straight away, approved as they prepare it", async () => {
    await overTheLimit({ mayApprove: true });
    expect(screen.getByText(/You approve it as you refund it/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Refund Rs 6,300.00/ })).toBeTruthy();
  });

  it("stays under the limit below it", async () => {
    await renderReturns();
    await findByInvoice();
    fireEvent.click(row("Softclix Lancets ×25"));
    press("+");
    expect(screen.queryByText(/refund limit/)).toBeNull();
  });
});

describe("Returns: from the web", () => {
  it("lists refunds prepared on the web and refunds the only one with F12", async () => {
    ready = [fromWeb];
    const counts: number[] = [];
    await renderReturns({ onCount: (n) => counts.push(n) });
    expect(counts.at(-1)).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /From web/ }));
    expect(screen.getByText("RF-0031 · Rs 1,840.00")).toBeTruthy();
    expect(screen.getByText(/Prepared by Nimal P. · approved by Dilini F./)).toBeTruthy();

    ready = [];
    press("F12");
    await act(async () => undefined);
    expect(pos.executeRefund).toHaveBeenCalledWith({ refundRequestId: fromWeb.refundRequestId });
    expect(screen.getByRole("status").textContent).toContain("Refunded RF-0031");
    expect(screen.getByRole("status").textContent).toContain("approved by Dilini F., refunded by you");
  });

  it("points from the found sale to the refund already prepared for it", async () => {
    ready = [fromWeb];
    await renderReturns();
    await findByInvoice();
    fireEvent.click(screen.getByRole("button", { name: /RF-0031 prepared on the web/ }));
    expect(screen.getByRole("button", { name: /From web/ }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Returns: a manager co-signs over the limit", () => {
  async function overTheLimit() {
    await renderReturns();
    await findByInvoice();
    fireEvent.click(row("Accu-Chek Active Strips ×50"));
    press("+");
    fireEvent.click(row("Softclix Lancets ×25"));
    press("+");
    await act(async () => undefined);
  }
  const box = () => screen.getByRole("group", { name: "Refund limit" });

  it("asks for the manager's PIN before refunding, and sends it with the refund", async () => {
    pos.submitReturn!.mockImplementation(async () => ({
      ok: true,
      value: {
        status: "refunded",
        refund: {
          requestNumber: "RFR-13", amountMinor: 630000, refundedTo: [{ method: "card", amountMinor: 630000 }],
          alreadyApplied: false, requestedBy: "Sachini R.", approvedBy: "Dilini Fernando",
        },
      },
    }));
    await overTheLimit();
    expect(within(box()).getByText("Dilini Fernando")).toBeTruthy();
    expect(within(box()).getByText("ready on this counter")).toBeTruthy();
    const refund = screen.getByRole("button", { name: /Refund Rs 6,300.00/ });
    expect(refund.hasAttribute("disabled")).toBe(true);
    press("F12");
    expect(pos.submitReturn).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Dilini Fernando's PIN"), { target: { value: "48a2913" } });
    expect((screen.getByLabelText("Dilini Fernando's PIN") as HTMLInputElement).value).toBe("482913");
    expect(refund.hasAttribute("disabled")).toBe(false);
    press("F12");
    await act(async () => undefined);
    expect(pos.submitReturn).toHaveBeenCalledWith(
      expect.objectContaining({ coSign: { approverUserId: id(50), pin: "482913" } }),
    );
    expect(screen.getByRole("status").textContent).toContain("Approved by Dilini Fernando");
  });

  it("asks a manager with no PIN for their login password", async () => {
    await overTheLimit();
    fireEvent.click(within(box()).getByText("Owner Perera"));
    fireEvent.change(screen.getByLabelText("Owner Perera's login password"), { target: { value: "s3cret-pass" } });
    press("F12");
    await act(async () => undefined);
    expect(pos.submitReturn).toHaveBeenCalledWith(
      expect.objectContaining({ coSign: { approverUserId: id(51), pin: "s3cret-pass" } }),
    );
  });

  it("after a refused PIN, keeps the request and the lines, and approves that request on retry", async () => {
    pos.submitReturn!.mockImplementation(async () => ({
      ok: true,
      value: {
        status: "awaiting_approval", refundRequestId: id(40), requestNumber: "RFR-13", amount: "6300.00",
        coSignRefusal: { code: "PIN_INVALID", message: "That PIN isn't right." },
      },
    }));
    await overTheLimit();
    fireEvent.change(screen.getByLabelText("Dilini Fernando's PIN"), { target: { value: "000000" } });
    press("F12");
    await act(async () => undefined);

    const alert = within(box()).getByRole("alert");
    expect(alert.textContent).toContain("That PIN isn't right.");
    expect(alert.textContent).toContain("RFR-13 is prepared and waiting; nothing was refunded.");
    // The PIN is cleared, and the lines can't change under the waiting request.
    expect((screen.getByLabelText("Dilini Fernando's PIN") as HTMLInputElement).value).toBe("");
    press("+");
    expect(screen.getByText(/coming back/).textContent).toBe("2 items · 2 units coming back");

    fireEvent.change(screen.getByLabelText("Dilini Fernando's PIN"), { target: { value: "482913" } });
    press("F12");
    await act(async () => undefined);
    expect(pos.submitReturn).toHaveBeenCalledTimes(1);
    expect(pos.approveReturn).toHaveBeenCalledWith({
      saleId: id(1),
      refundRequestId: id(40),
      coSign: { approverUserId: id(50), pin: "482913" },
    });
    expect(screen.getByRole("status").textContent).toContain("Refunded Rs 6,300.00");
  });

  it("not here? sends it for approval on the web, without a PIN", async () => {
    pos.submitReturn!.mockImplementation(async () => ({
      ok: true,
      value: { status: "awaiting_approval", refundRequestId: id(40), requestNumber: "RFR-13", amount: "6300.00" },
    }));
    await overTheLimit();
    fireEvent.click(screen.getByRole("button", { name: "Send it for approval on the web" }));
    await act(async () => undefined);
    expect(pos.submitReturn).toHaveBeenCalledWith(expect.not.objectContaining({ coSign: expect.anything() }));
    expect(screen.getByRole("status").textContent).toContain("Sent for approval as RFR-13");
  });
});
