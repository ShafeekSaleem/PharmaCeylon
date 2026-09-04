import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { SegmentedTabPanel, SegmentedTabs } from "./segmented-tabs";

const ITEMS = [
  { id: "queue" as const, label: "Work queue", count: 24, attention: true, countLabel: "open tasks" },
  { id: "categories" as const, label: "Categories" },
  { id: "tags" as const, label: "Tags" },
];

function Harness({ initial = "queue" }: { initial?: "queue" | "categories" | "tags" }) {
  const [active, setActive] = useState<"queue" | "categories" | "tags">(initial);
  return (
    <>
      <SegmentedTabs
        items={ITEMS}
        active={active}
        onChange={setActive}
        ariaLabel="Catalog management sections"
      />
      <SegmentedTabPanel id="queue" active={active === "queue"}>
        <p>Queue panel</p>
      </SegmentedTabPanel>
      <SegmentedTabPanel id="categories" active={active === "categories"}>
        <p>Categories panel</p>
      </SegmentedTabPanel>
      <SegmentedTabPanel id="tags" active={active === "tags"}>
        <p>Tags panel</p>
      </SegmentedTabPanel>
    </>
  );
}

/**
 * These are real ARIA tabs — the panels are rendered in place, not navigated to — so the
 * keyboard contract that comes with `role="tab"` has to actually work. Borrowing tab roles for
 * what is really navigation, and leaving arrow keys dead, is the common version of this
 * mistake; these tests are what stop this component becoming that.
 */
describe("SegmentedTabs", () => {
  it("exposes a labelled tablist with one selected tab", () => {
    render(<Harness />);

    expect(screen.getByRole("tablist", { name: "Catalog management sections" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(/Work queue/);
  });

  it("spells the count out in the accessible name rather than leaving a bare number", () => {
    render(<Harness />);

    expect(screen.getByRole("tab", { name: "Work queue, 24 open tasks" })).toBeInTheDocument();
  });

  it("shows only the active panel", () => {
    render(<Harness />);

    expect(screen.getByText("Queue panel")).toBeInTheDocument();
    expect(screen.queryByText("Categories panel")).not.toBeInTheDocument();
  });

  it("switches panel on click", async () => {
    render(<Harness />);

    await userEvent.click(screen.getByRole("tab", { name: "Categories" }));

    expect(screen.getByText("Categories panel")).toBeInTheDocument();
    expect(screen.queryByText("Queue panel")).not.toBeInTheDocument();
  });

  it("keeps the bar a single tab stop via a roving tabindex", () => {
    render(<Harness />);

    const [queue, categories, tags] = screen.getAllByRole("tab");
    expect(queue).toHaveAttribute("tabindex", "0");
    expect(categories).toHaveAttribute("tabindex", "-1");
    expect(tags).toHaveAttribute("tabindex", "-1");
  });

  describe("keyboard", () => {
    it("moves right with ArrowRight", async () => {
      render(<Harness />);
      screen.getAllByRole("tab")[0].focus();

      await userEvent.keyboard("{ArrowRight}");

      expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Categories");
      expect(screen.getByText("Categories panel")).toBeInTheDocument();
    });

    it("wraps from the last tab back to the first", async () => {
      render(<Harness initial="tags" />);
      screen.getAllByRole("tab")[2].focus();

      await userEvent.keyboard("{ArrowRight}");

      expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(/Work queue/);
    });

    it("wraps backwards from the first tab to the last", async () => {
      render(<Harness />);
      screen.getAllByRole("tab")[0].focus();

      await userEvent.keyboard("{ArrowLeft}");

      expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Tags");
    });

    it("jumps to the ends with Home and End", async () => {
      render(<Harness />);
      screen.getAllByRole("tab")[0].focus();

      await userEvent.keyboard("{End}");
      expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Tags");

      await userEvent.keyboard("{Home}");
      expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(/Work queue/);
    });

    it("moves focus with selection, so the arrow keys are usable without a mouse", async () => {
      render(<Harness />);
      screen.getAllByRole("tab")[0].focus();

      await userEvent.keyboard("{ArrowRight}");

      expect(screen.getByRole("tab", { name: "Categories" })).toHaveFocus();
    });
  });

  it("wires each panel to its tab", () => {
    render(<Harness />);

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", "segtab-queue");
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute(
      "aria-controls",
      "segpanel-queue",
    );
  });
});
