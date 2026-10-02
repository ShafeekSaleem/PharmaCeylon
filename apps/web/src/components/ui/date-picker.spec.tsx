import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { pickDate } from "@/test-utils/pick-date";
import { DatePicker } from "./date-picker";
import { Modal } from "./modal";

function Harness(props: { initial?: string; min?: string; max?: string; required?: boolean; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <DatePicker
      label="Expiry date"
      variant="field"
      value={value}
      min={props.min}
      max={props.max}
      required={props.required}
      clearable={!props.required}
      onChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
    />
  );
}

const popover = () => screen.queryByRole("dialog", { name: /choose a date/ });

it("shows the chosen date the way the app's tables write dates", () => {
  render(<Harness initial="2027-06-30" />);
  expect(screen.getByRole("button", { name: "Expiry date: Jun 30, 2027" })).toBeInTheDocument();
});

it("hands back the same YYYY-MM-DD string a native date input did", () => {
  const onChange = jest.fn();
  render(<Harness onChange={onChange} />);
  pickDate(/Expiry date/, "2027-02-14");
  expect(onChange).toHaveBeenCalledWith("2027-02-14");
  expect(popover()).not.toBeInTheDocument();
});

it("can be driven from the keyboard", () => {
  const onChange = jest.fn();
  render(<Harness initial="2027-06-30" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: /Expiry date/ }));
  const grid = within(popover()!).getByRole("grid");
  fireEvent.keyDown(grid, { key: "ArrowRight" });
  fireEvent.keyDown(grid, { key: "ArrowDown" });
  fireEvent.keyDown(grid, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("2027-07-08");
});

it("won't offer days outside min and max", () => {
  render(<Harness initial="2027-06-15" min="2027-06-10" max="2027-06-20" />);
  fireEvent.click(screen.getByRole("button", { name: /Expiry date/ }));
  expect(within(popover()!).getByRole("gridcell", { name: "Wednesday, June 9, 2027" })).toBeDisabled();
  expect(within(popover()!).getByRole("gridcell", { name: "Thursday, June 10, 2027" })).toBeEnabled();
  expect(within(popover()!).getByRole("gridcell", { name: "Monday, June 21, 2027" })).toBeDisabled();
});

it("clears when clearing is allowed, and doesn't offer it when the date is required", () => {
  const { unmount } = render(<Harness initial="2027-06-15" />);
  fireEvent.click(screen.getByRole("button", { name: /Expiry date/ }));
  fireEvent.click(within(popover()!).getByRole("button", { name: "Clear" }));
  expect(screen.getByRole("button", { name: "Expiry date: Any date" })).toBeInTheDocument();
  unmount();

  render(<Harness initial="2027-06-15" required />);
  fireEvent.click(screen.getByRole("button", { name: /Expiry date/ }));
  expect(within(popover()!).queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
});

it("Escape closes the calendar, not the modal it was opened in", () => {
  const onClose = jest.fn();
  render(
    <Modal open title="Receive goods" onClose={onClose}>
      <Harness />
    </Modal>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Expiry date/ }));
  expect(popover()).toBeInTheDocument();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(popover()).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});
