import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterChips } from "./filter-chips";

/**
 * Shared list pattern (#205): neutral filter chips with counts, and exactly one filled chip for
 * the applied filter. Inventory and Purchasing will reuse this, so the rules are pinned here.
 */
describe("FilterChips", () => {
  const chips = [
    { id: "all", label: "All", count: 1240 },
    { id: "inactive", label: "Inactive", count: 12 },
    { id: "low", label: "Low stock", count: null },
  ];

  it("names the group and shows each label with its count", () => {
    render(
      <FilterChips label="Product status" chips={chips} active="all" onChange={jest.fn()} />,
    );

    expect(screen.getByRole("group", { name: "Product status" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All\s*1,240/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inactive\s*12/ })).toBeInTheDocument();
  });

  it("leaves the count out while it is unknown rather than printing 0", () => {
    render(
      <FilterChips label="Product status" chips={chips} active="all" onChange={jest.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Low stock" })).toBeInTheDocument();
    expect(screen.getAllByTestId("filter-chip-count")).toHaveLength(2);
  });

  it("presses exactly one chip: the applied filter", () => {
    render(
      <FilterChips
        label="Product status"
        chips={chips}
        active="inactive"
        onChange={jest.fn()}
      />,
    );

    const pressed = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toHaveTextContent("Inactive");
  });

  it("presses none when the list is filtered some other way", () => {
    render(
      <FilterChips label="Product status" chips={chips} active={null} onChange={jest.fn()} />,
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("reports the chip that was pressed", async () => {
    const onChange = jest.fn();
    render(
      <FilterChips label="Product status" chips={chips} active="all" onChange={onChange} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Inactive/ }));

    expect(onChange).toHaveBeenCalledWith("inactive");
  });

  it("does not fire a disabled chip, and says why it is disabled", async () => {
    const onChange = jest.fn();
    render(
      <FilterChips
        label="Product status"
        chips={[
          {
            id: "low",
            label: "Low stock",
            disabled: true,
            hint: "Select a branch to filter by stock",
          },
        ]}
        active={null}
        onChange={onChange}
      />,
    );

    const chip = screen.getByRole("button", { name: "Low stock" });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute("title", "Select a branch to filter by stock");
    await userEvent.click(chip);
    expect(onChange).not.toHaveBeenCalled();
  });
});
