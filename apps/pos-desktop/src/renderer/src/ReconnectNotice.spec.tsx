/** @jest-environment jsdom */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import type {
  JournalSync,
  OfflineJournalEntry,
  OfflineJournalQueue,
  OfflineModeState,
} from "../../shared/ipc-contract";
import { deviceState, renderWithKeys, stubPos } from "../test/harness";
import { LastOfflineSale, ReconnectBanner } from "./ReconnectNotice";
import { reconnectNotice } from "./reconnect-model";
import { SyncBlock, TitleBar } from "./Shell";

/** P4 #50, slice 4c: the upload queue in the title bar, and the last offline sale after reconnecting. */

afterEach(cleanup);

const printer = { name: "EPSON-TM", displayName: "EPSON TM-T82" };

function entry(
  sequence: number,
  over: Partial<OfflineJournalEntry> = {},
): OfflineJournalEntry {
  return {
    commandId: `00000000-0000-4000-8000-0000000000${sequence}`,
    sequence,
    kind: "sale",
    at: "2026-11-17T10:50:00.000Z",
    receiptNumber: `C1R-${String(170 + sequence).padStart(6, "0")}`,
    totalMinor: 69_200,
    status: "accepted",
    stockReview: false,
    notHonoured: false,
    refusalCode: null,
    printable: true,
    ...over,
  };
}
const queue = (...entries: OfflineJournalEntry[]): OfflineJournalQueue => ({
  entries,
  more: false,
});

const sync: JournalSync = {
  recorded: 16,
  accepted: 14,
  waiting: 2,
  refused: 0,
  syncing: false,
  lastSuccessAt: null,
  issue: null,
  pause: {
    reason: "draining",
    waiting: 2,
    outageStartedAt: "2026-11-17T10:13:00.000Z",
    unconfirmed: { sales: 0, actions: 0 },
    holds: { cards: 0, records: 0, refused: 0 },
  },
  lastDrainAt: null,
  lastStockDownloadAt: null,
  stockDownloadNominated: true,
};
const mode = (over: Partial<OfflineModeState> = {}): OfflineModeState => ({
  mode: "draining",
  reason: null,
  clock: null,
  connected: true,
  outageStartedAt: "2026-11-17T10:13:00.000Z",
  grantExpiresAt: null,
  snapshotGeneratedAt: null,
  ...over,
});
const api = { reachable: true, checkedAt: "2026-11-17T10:58:00.000Z" } as never;

describe("the title bar's upload queue", () => {
  it("opens the list from the count while synchronising (d-drain)", () => {
    const list = queue(
      entry(16, { status: "sending" }),
      entry(15, { status: "sending" }),
      entry(14),
    );
    renderWithKeys(
      <TitleBar
        state={deviceState()}
        api={api}
        journal={sync}
        mode={mode()}
        queue={list}
      />,
    );
    const chip = screen.getByRole("button", { name: "2 to send" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", {
      name: "Synchronising offline sales",
    });
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Sale · journal #16");
    expect(rows[0]?.textContent).toContain("C1R-000186");
    expect(rows[0]?.textContent).toContain("Rs 692.00");
    expect(rows[0]?.textContent).toContain("Sending");
    expect(rows[2]?.textContent).toContain("Accepted");
    expect(dialog.textContent).toContain(
      "Checkout stays paused on this counter until this list is clear",
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("waits to upload while offline (d-queue)", () => {
    const list = queue(
      entry(16, { status: "queued" }),
      entry(15, { status: "queued" }),
    );
    renderWithKeys(
      <TitleBar
        state={deviceState()}
        api={
          { reachable: false, checkedAt: "2026-11-17T10:58:00.000Z" } as never
        }
        journal={{ ...sync, pause: null }}
        mode={mode({ mode: "offline", connected: false })}
        queue={list}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "2 to send" }));
    const dialog = screen.getByRole("dialog", { name: "Waiting to upload" });
    expect(dialog.textContent).toContain(
      "You don't need to retry a queued sale.",
    );
    expect(within(dialog).getAllByText("Queued")).toHaveLength(2);
  });

  it("marks entries behind a refused one waiting, and keeps the counter paused (d-review, Q4)", () => {
    const list = queue(
      entry(16, { status: "waiting" }),
      entry(15, { status: "refused", refusalCode: "REPLAY_CONFLICT" }),
      entry(14),
    );
    renderWithKeys(
      <TitleBar
        state={deviceState()}
        api={api}
        journal={{ ...sync, refused: 1 }}
        mode={mode()}
        queue={list}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "2 need review" }));
    const dialog = screen.getByRole("dialog", {
      name: "Needs a manager review",
    });
    expect(dialog.textContent).toContain(
      "The server refused journal entry 15.",
    );
    expect(dialog.textContent).toContain("stays paused until then");
    expect(within(dialog).getByText("Waiting")).toBeTruthy();
    expect(within(dialog).getByText("Needs review")).toBeTruthy();
  });

  it("shows no count once everything is accepted (d-clean)", () => {
    renderWithKeys(
      <TitleBar
        state={deviceState()}
        api={api}
        journal={{ ...sync, waiting: 0, pause: null }}
        mode={mode({ mode: "online" })}
        queue={queue(entry(16))}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /to send|need review/ }),
    ).toBeNull();
  });
});

describe("the last offline sale (#212 note 1)", () => {
  it("reprints the receipt kept on this counter", async () => {
    const pos = stubPos({
      printOfflineReceipt: async () => ({ ok: true, error: null }),
    });
    renderWithKeys(
      <LastOfflineSale
        entry={entry(16, { status: "sending" })}
        printer={printer}
      />,
    );
    expect(screen.getByText("C1R-000186")).toBeTruthy();
    expect(screen.getByText("Sending")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reprint" }));
    });
    expect(pos.printOfflineReceipt).toHaveBeenCalledWith({
      saleCommandId: entry(16).commandId,
      printerName: "EPSON-TM",
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Receipt sent to the printer.",
    );
  });

  it("says why it didn't print", async () => {
    stubPos({
      printOfflineReceipt: async () => ({
        ok: false,
        error: "The printer is out of paper.",
      }),
    });
    renderWithKeys(<LastOfflineSale entry={entry(16)} printer={printer} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reprint" }));
    });
    expect(screen.getByRole("status").textContent).toBe(
      "The printer is out of paper.",
    );
  });

  it("can't reprint without a printer, or a receipt this computer no longer holds", () => {
    const { rerender } = renderWithKeys(
      <LastOfflineSale entry={entry(16)} printer={null} />,
    );
    expect(
      (screen.getByRole("button", { name: "Reprint" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    rerender(
      <LastOfflineSale
        entry={entry(16, { printable: false })}
        printer={printer}
      />,
    );
    expect(screen.queryByRole("button", { name: "Reprint" })).toBeNull();
  });

  it("stays in the synchronisation block, with the corrected review wording", () => {
    const list = queue(
      entry(16, { status: "waiting" }),
      entry(15, { status: "refused" }),
    );
    const journal = { ...sync, refused: 1 };
    renderWithKeys(
      <SyncBlock sync={journal} notice={reconnectNotice(journal, list)}>
        <LastOfflineSale
          entry={entry(16, { status: "waiting" })}
          printer={printer}
        />
      </SyncBlock>,
    );
    expect(
      screen.getByRole("heading", { name: "2 sales need a manager review" }),
    ).toBeTruthy();
    const block = screen.getAllByRole("status")[0]!;
    expect(block.textContent).toContain(
      "stays paused until a manager settles it on the web",
    );
    expect(block.textContent).not.toContain(
      "New sales start again as soon as it finishes",
    );
    expect(screen.getByRole("button", { name: "Reprint" })).toBeTruthy();
  });
});

describe("ReconnectBanner", () => {
  it("shows stock under review on the last sale, and can be put away (d-stock)", () => {
    const onDismiss = jest.fn();
    renderWithKeys(
      <ReconnectBanner
        notice={{
          tone: "warn",
          title: "All offline sales were accepted · Stock under review",
          text: "A manager is reviewing the stock for receipt C1R-000185.",
          dismissible: true,
        }}
        lastSale={entry(15, { stockReview: true })}
        printer={printer}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getAllByText("Stock under review")).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Put this message away" }),
    );
    expect(onDismiss).toHaveBeenCalled();
  });

  it("says the receipt number is unchanged, with the sale marked uploaded (d-clean)", () => {
    renderWithKeys(
      <ReconnectBanner
        notice={{
          tone: "ok",
          title: "All offline sales were accepted",
          text: "Fresh stock is installed. Checkout is open again. Receipt C1R-000186 is unchanged.",
          dismissible: true,
        }}
        lastSale={entry(16)}
        printer={printer}
      />,
    );
    expect(screen.getByText(/Receipt C1R-000186 is unchanged/)).toBeTruthy();
    expect(screen.getByText("Uploaded")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Put this message away" }),
    ).toBeNull();
  });
});
