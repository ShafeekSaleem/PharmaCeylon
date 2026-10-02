import { fireEvent, screen, within } from "@testing-library/react";

const longDay = (date: Date) =>
  date.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/**
 * Choose a date in the app's calendar (`DatePicker`) the way a person does: open the field,
 * page to the month, click the day. Works whatever today's date is when the test runs.
 *
 * `field` matches the trigger's accessible name, which starts with the field's label.
 */
export function pickDate(field: RegExp, iso: string) {
  fireEvent.click(screen.getByRole("button", { name: field }));
  const target = new Date(`${iso}T00:00:00`);
  const wanted = target.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const popover = screen.getByRole("dialog", { name: /choose a date/ });

  for (let step = 0; step < 240; step += 1) {
    const shown = popover.querySelector("[aria-live]")?.textContent ?? "";
    if (shown === wanted) break;
    const [month, year] = shown.split(" ");
    const showing = new Date(`${month} 1, ${year}`);
    fireEvent.click(
      within(popover).getByRole("button", { name: showing < target ? "Next month" : "Previous month" }),
    );
  }
  fireEvent.click(within(popover).getByRole("gridcell", { name: longDay(target) }));
}
