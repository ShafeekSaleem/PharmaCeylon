import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BranchHours, BranchHoursView, HolidaySuggestionsView } from "@pharmaceylon/shared";
import { ApiError } from "@/lib/api-error";
import { saveBranchHours } from "../hours-api";
import { BranchHoursEditor } from "./branch-hours-editor";

jest.mock("../hours-api", () => ({ saveBranchHours: jest.fn() }));
const save = saveBranchHours as jest.Mock;

const open = { mode: "hours", ranges: [{ opens: "08:00", closes: "20:00" }] } as const;
function hours(overrides: Partial<BranchHours> = {}): BranchHours {
  return {
    schemaVersion: 1,
    weekly: { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: { mode: "closed" } },
    exceptions: [],
    mandatory: null,
    ...overrides,
  };
}
function view(overrides: Partial<BranchHoursView> = {}): BranchHoursView {
  return {
    branchId: "branch-1",
    branchName: "Colombo 03",
    timezone: "Asia/Colombo",
    version: 4,
    hours: hours(),
    origin: "editor",
    updatedAt: null,
    updatedBy: null,
    legacyText: null,
    extensions: [],
    ...overrides,
  };
}
const noHolidayList: HolidaySuggestionsView = { source: null, holidays: [] };

function renderEditor(props: Partial<Parameters<typeof BranchHoursEditor>[0]> = {}) {
  const onSaved = jest.fn();
  render(
    <BranchHoursEditor
      view={view()}
      canEdit
      canEditMandatory
      holidays={noHolidayList}
      onSaved={onSaved}
      {...props}
    />,
  );
  return { onSaved };
}
const sent = () => save.mock.calls.at(-1)?.[1] as { expectedVersion: number; hours: BranchHours; confirmNoSelling?: boolean };

beforeEach(() => {
  save.mockImplementation(async (_id: string, input: { hours: BranchHours }) => view({ hours: input.hours, version: 5 }));
});

it("starts a branch with no hours from unsaved starting hours and no mandatory limit", async () => {
  renderEditor({ view: view({ hours: null, origin: null, version: 1 }) });
  expect(screen.getByText(/These are starting hours, not saved/)).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /No mandatory limit/ })).toBeChecked();

  fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(sent().expectedVersion).toBe(1);
  expect(sent().hours.mandatory).toBeNull();
  expect(sent().hours.weekly.sun).toEqual(open);
});

it("shows the old free text beside hours read from it, and asks for a check", () => {
  renderEditor({ view: view({ origin: "legacy_text", legacyText: "Mon-Sat 8am-8pm" }) });
  expect(screen.getByText(/read from what was entered before: “Mon-Sat 8am-8pm”/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save hours" })).toBeEnabled();
});

it("shows text that couldn't be read so the owner can enter it", () => {
  renderEditor({ view: view({ hours: null, origin: null, legacyText: "8 - 5, poya closed" }) });
  expect(screen.getByText(/couldn't be read automatically: “8 - 5, poya closed”/)).toBeInTheDocument();
});

it("says changes reach counters after their next sync", () => {
  renderEditor();
  expect(screen.getByText("Applies to counters after their next sync.")).toBeInTheDocument();
});

it("saves 24-hour days and late closing against the loaded version", async () => {
  renderEditor();
  expect(screen.getByRole("button", { name: "Save hours" })).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Friday" }), { target: { value: "open_24h" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Saturday" }), { target: { value: "hours" } });
  fireEvent.change(screen.getByLabelText("Saturday until"), { target: { value: "02:00" } });
  expect(screen.getByText("ends the next day")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(sent()).toMatchObject({ expectedVersion: 4 });
  expect(sent().hours.weekly.fri).toEqual({ mode: "open_24h" });
  expect(sent().hours.weekly.sat).toEqual({ mode: "hours", ranges: [{ opens: "08:00", closes: "02:00" }] });
  expect(sent()).not.toHaveProperty("confirmNoSelling");
  expect(await screen.findByText("Hours saved.")).toBeInTheDocument();
});

it("explains invalid hours instead of sending them", async () => {
  renderEditor();
  fireEvent.change(screen.getByLabelText("Monday until"), { target: { value: "08:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
  expect(await screen.findByText(/Monday: opening and closing times can't be the same/)).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});

describe("no selling", () => {
  it("needs a second confirmation, and cancelling sends nothing", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("radio", { name: /No selling at all/ }));
    expect(screen.getByText(/No selling at all at this branch, at any time/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Stop all selling at Colombo 03?")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep selling" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(save).not.toHaveBeenCalled();
  });

  it("saves an empty mandatory list only after the owner confirms", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("radio", { name: /No selling at all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop all selling" }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(sent().hours.mandatory).toEqual([]);
    expect(sent().confirmNoSelling).toBe(true);
  });

  it("treats a limit that leaves no day with selling time as no selling", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("radio", { name: /Only allow selling at set times/ }));
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
      fireEvent.change(screen.getByRole("combobox", { name: `Mandatory ${day}` }), { target: { value: "closed" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("asks for the confirmation when the server does", async () => {
    save.mockRejectedValueOnce(
      new ApiError("Confirm it to save.", 400, { code: "NO_SELLING_CONFIRMATION_REQUIRED" }),
    );
    renderEditor({ view: view({ hours: hours({ mandatory: [] }) }) });
    fireEvent.change(screen.getByRole("combobox", { name: "Sunday" }), { target: { value: "open_24h" } });
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

it("starts a mandatory limit at 'any time' so choosing it restricts nothing by itself", async () => {
  renderEditor();
  fireEvent.click(screen.getByRole("radio", { name: /Only allow selling at set times/ }));
  expect(screen.getByRole("combobox", { name: "Mandatory Sunday" })).toHaveValue("open_24h");
  fireEvent.change(screen.getByRole("combobox", { name: "Mandatory Sunday" }), { target: { value: "closed" } });
  expect(screen.getByText("No selling at all on Sunday.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(sent().hours.mandatory).toHaveLength(6);
  expect(sent().hours.mandatory).toContainEqual({ day: "mon", opens: "00:00", closes: "24:00" });
  expect(sent().hours.mandatory?.some((w) => w.day === "sun")).toBe(false);
});

it("lets a manager change routine hours but not mandatory limits", async () => {
  const mandatory = [{ day: "mon", opens: "06:00", closes: "22:00" }] as BranchHours["mandatory"];
  renderEditor({ canEditMandatory: false, view: view({ hours: hours({ mandatory }) }) });
  expect(screen.getByText("Only the owner can change mandatory selling limits.")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /No mandatory limit/ })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Mandatory Monday" })).toBeDisabled();

  fireEvent.change(screen.getByRole("combobox", { name: "Sunday" }), { target: { value: "open_24h" } });
  fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(sent().hours.mandatory).toEqual(mandatory);
});

it("is read-only without edit rights", () => {
  renderEditor({ canEdit: false });
  expect(screen.queryByRole("button", { name: "Save hours" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Monday" })).toBeDisabled();
  expect(screen.getByText("Applies to counters after their next sync.")).toBeInTheDocument();
});

it("reports a conflicting save and offers a reload", async () => {
  save.mockRejectedValueOnce(
    new ApiError("Someone changed these hours since you opened them.", 409, { code: "HOURS_VERSION_CONFLICT" }),
  );
  renderEditor();
  fireEvent.change(screen.getByRole("combobox", { name: "Sunday" }), { target: { value: "open_24h" } });
  fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
  expect(await screen.findByText(/Someone changed these hours/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
});

describe("dates and holidays", () => {
  it("adds a dated exception, closed by default", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("New date"), { target: { value: "2099-11-05" } });
    fireEvent.change(screen.getByLabelText("New date name"), { target: { value: "Stocktake" } });
    fireEvent.click(screen.getByRole("button", { name: "Add date" }));
    expect(screen.getByRole("combobox", { name: "Hours on 2099-11-05" })).toHaveValue("closed");

    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(sent().hours.exceptions).toEqual([
      { date: "2099-11-05", label: "Stocktake", hours: { mode: "closed" }, source: "owner", holidayKey: null },
    ]);
  });

  it("says there is nothing to suggest until a holiday list is set up", () => {
    renderEditor();
    expect(screen.getByText(/No public or poya holiday list has been set up yet/)).toBeInTheDocument();
  });

  it("offers holidays for the owner to confirm, never adding them by itself", async () => {
    const holidays: HolidaySuggestionsView = {
      source: { name: "Test holiday list", reference: null },
      holidays: [
        { key: "lk:2099-05-01:vesak", date: "2099-05-01", name: "Vesak Full Moon Poya Day", kinds: ["poya", "public"] },
        { key: "lk:2099-12-25:christmas", date: "2099-12-25", name: "Christmas Day", kinds: ["public"] },
      ],
    };
    renderEditor({
      holidays,
      view: view({
        hours: hours({
          exceptions: [
            { date: "2099-12-25", label: "Christmas", hours: { mode: "closed" }, source: "owner", holidayKey: null },
          ],
        }),
      }),
    });
    expect(screen.getByText(/doesn't decide legal trading hours/)).toBeInTheDocument();
    // Christmas is already a dated exception, so only Vesak is offered.
    expect(screen.queryByRole("checkbox", { name: /Christmas Day/ })).not.toBeInTheDocument();
    const vesak = screen.getByRole("checkbox", { name: /Vesak Full Moon Poya Day/ });
    expect(vesak).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: "Hours on 2099-05-01" })).not.toBeInTheDocument();

    fireEvent.click(vesak);
    fireEvent.click(screen.getByRole("button", { name: "Add selected as closed days" }));
    expect(screen.getByText("Suggested holiday")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(sent().hours.exceptions).toContainEqual({
      date: "2099-05-01",
      label: "Vesak Full Moon Poya Day",
      hours: { mode: "closed" },
      source: "holiday_suggestion",
      holidayKey: "lk:2099-05-01:vesak",
    });
  });
});
