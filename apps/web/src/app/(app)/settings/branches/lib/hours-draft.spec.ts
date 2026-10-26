import type { BranchHours } from "@pharmaceylon/shared";
import {
  branchLocalToIso,
  branchToday,
  describeDay,
  draftFromHours,
  hoursFromDraft,
  startingHours,
} from "./hours-draft";

const base = startingHours();

it("starting hours never carry a mandatory limit", () => {
  expect(base.mandatory).toBeNull();
  expect(draftFromHours(base).mandatoryMode).toBe("none");
});

it("keeps D8's null versus empty through the editor", () => {
  expect(hoursFromDraft(draftFromHours({ ...base, mandatory: null })).mandatory).toBeNull();
  const none = draftFromHours({ ...base, mandatory: [] });
  expect(none.mandatoryMode).toBe("no_selling");
  expect(hoursFromDraft(none).mandatory).toEqual([]);
});

it("round-trips mandatory windows, full days and days without selling", () => {
  const mandatory: BranchHours["mandatory"] = [
    { day: "mon", opens: "00:00", closes: "24:00" },
    { day: "tue", opens: "06:00", closes: "12:00" },
    { day: "tue", opens: "14:00", closes: "22:00" },
  ];
  const draft = draftFromHours({ ...base, mandatory });
  expect(draft.mandatoryDays.mon).toEqual({ mode: "open_24h" });
  expect(draft.mandatoryDays.wed).toEqual({ mode: "closed" });
  expect(hoursFromDraft(draft).mandatory).toEqual(mandatory);
});

it("describes days in plain words", () => {
  expect(describeDay({ mode: "closed" })).toBe("Closed");
  expect(describeDay({ mode: "open_24h" })).toBe("Open 24 hours");
  expect(describeDay({ mode: "hours", ranges: [{ opens: "18:00", closes: "02:00" }] })).toBe(
    "18:00–02:00 (next day)",
  );
});

it("reads times on the branch's clock, not the browser's", () => {
  expect(branchLocalToIso("2026-10-31T20:00", "Asia/Colombo")).toBe("2026-10-31T14:30:00.000Z");
  expect(branchLocalToIso("2026-10-31T20:00", "UTC")).toBe("2026-10-31T20:00:00.000Z");
  expect(branchLocalToIso("2026-10-31", "Asia/Colombo")).toBeNull();
  // 23:00 UTC is already the next day in Colombo.
  expect(branchToday("Asia/Colombo", new Date("2026-10-27T23:00:00.000Z"))).toBe("2026-10-28");
});
