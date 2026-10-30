import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BranchHours } from "@pharmaceylon/shared";
import { OnboardingHoursFields } from "./onboarding-hours-fields";

function Harness() {
  const [hours, setHours] = useState<BranchHours | null>(null);
  return (
    <>
      <OnboardingHoursFields value={hours} onChange={setHours} />
      <output data-testid="hours">{JSON.stringify(hours)}</output>
    </>
  );
}
it("leaves hours unset until chosen, supports 24-hour and overnight days, and never invents mandatory limits", () => {
  render(<Harness />);
  expect(screen.getByTestId("hours")).toHaveTextContent("null");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Set routine opening hours now" }),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Monday" }), {
    target: { value: "open_24h" },
  });
  fireEvent.change(screen.getByLabelText("Tuesday from"), {
    target: { value: "20:00" },
  });
  fireEvent.change(screen.getByLabelText("Tuesday until"), {
    target: { value: "06:00" },
  });
  const saved = JSON.parse(screen.getByTestId("hours").textContent!);
  expect(saved.weekly.mon).toEqual({ mode: "open_24h" });
  expect(saved.weekly.tue.ranges[0]).toEqual({
    opens: "20:00",
    closes: "06:00",
  });
  expect(saved.mandatory).toBeNull();
  expect(screen.getByText("ends the next day")).toBeInTheDocument();
});
it("collects a dated exception and permits configuring hours later", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Add a date with different hours" }),
  );
  fireEvent.change(screen.getByLabelText("Exception date 1"), {
    target: { value: "2026-12-25" },
  });
  fireEvent.change(screen.getByLabelText("Exception reason 1"), {
    target: { value: "Owner-confirmed holiday" },
  });
  expect(
    JSON.parse(screen.getByTestId("hours").textContent!).exceptions[0],
  ).toMatchObject({
    date: "2026-12-25",
    source: "owner",
    holidayKey: null,
    hours: { mode: "closed" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByTestId("hours")).toHaveTextContent("null");
});
