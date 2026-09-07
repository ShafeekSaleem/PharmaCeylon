import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryTree } from "./category-tree";
import type { CommercialCategoryNode } from "../types";

function node(
  over: Partial<CommercialCategoryNode> = {},
): CommercialCategoryNode {
  return {
    id: "c1",
    name: "Pain & Fever",
    canonicalKey: "MEDICINES_PAIN_FEVER",
    source: "SYSTEM_TEMPLATE",
    isSystem: true,
    isActive: true,
    sortOrder: 0,
    rangedCount: 43,
    referenceCount: 1200,
    productCount: 1243,
    children: [],
    ...over,
  };
}

const TREE: CommercialCategoryNode[] = [
  node({
    id: "d1",
    name: "Medicines",
    canonicalKey: "MEDICINES",
    rangedCount: 745,
    referenceCount: 5000,
    productCount: 5745,
    children: [
      node({ id: "c1", name: "Pain & Fever" }),
      node({ id: "c2", name: "Cold, Cough & Allergy", rangedCount: 41 }),
    ],
  }),
  node({
    id: "d2",
    name: "Own Brand",
    canonicalKey: null,
    isSystem: false,
    rangedCount: 0,
    referenceCount: 0,
    productCount: 0,
    children: [],
  }),
];

function renderTree(
  over: Partial<React.ComponentProps<typeof CategoryTree>> = {},
) {
  const props = {
    nodes: TREE,
    query: "",
    canWrite: true,
    canDelete: true,
    busyId: null,
    onToggleActive: jest.fn(),
    onRequestAddChild: jest.fn(),
    onRequestRename: jest.fn(),
    onDelete: jest.fn(),
    onMoveProducts: jest.fn(),
    ...over,
  };
  render(<CategoryTree {...props} />);
  return props;
}

function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest("tr")!;
}

function groupFor(name: string): HTMLElement {
  return screen.getByText(name).closest("tbody")!;
}

/**
 * The tree is a table: one row per department, the same numbers down each column, and the
 * subcategories of whichever row is open beneath it. These tests pin what that redesign is for —
 * departments summarise and start closed, one opens at a time, biggest subcategory first, and
 * only the informative chips are drawn.
 */
describe("CategoryTree", () => {
  it("starts closed, showing departments rather than every category", () => {
    renderTree();

    expect(screen.getByText("Medicines")).toBeInTheDocument();
    expect(screen.queryByText("Pain & Fever")).toBeNull();
  });

  it("summarises what is inside a closed department", () => {
    renderTree();

    const row = rowFor("Medicines");
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText("745")).toBeInTheDocument();
  });

  it("labels the columns those numbers sit under", () => {
    renderTree();

    expect(
      screen.getByRole("columnheader", { name: "Subcategories" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Products" }),
    ).toBeInTheDocument();
  });

  it("opens on the disclosure", async () => {
    renderTree();

    await userEvent.click(
      screen.getByRole("button", { name: "Expand Medicines" }),
    );

    expect(screen.getByText("Pain & Fever")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse Medicines" }),
    ).toBeInTheDocument();
  });

  it("disables the disclosure on a department with nothing in it", () => {
    renderTree();

    expect(
      screen.getByRole("button", { name: "Expand Own Brand" }),
    ).toBeDisabled();
  });

  /**
   * A match hidden behind a closed department is not a match. Searching opens everything so the
   * result is on screen rather than one click away.
   */
  it("reveals matches when searching, without needing the department opened", () => {
    renderTree({ query: "cough" });

    expect(screen.getByText("Cold, Cough & Allergy")).toBeInTheDocument();
  });

  it("drops departments that match nothing", () => {
    renderTree({ query: "cough" });

    expect(screen.queryByText("Own Brand")).toBeNull();
  });

  it("says so when nothing matches", () => {
    renderTree({ query: "zzz" });

    expect(screen.getByText("No categories match.")).toBeInTheDocument();
  });

  describe("chips", () => {
    it("marks the pharmacy's own categories, not the twenty standard ones", () => {
      renderTree();

      // "Custom" appears once — on the tenant-created department, which is the informative
      // case. The previous version chipped every row "Standard", which distinguished nothing.
      expect(screen.getAllByText("Custom")).toHaveLength(1);
      expect(screen.queryByText("Standard")).toBeNull();
    });

    it("says a hidden category is hidden rather than only fading it", () => {
      renderTree({
        nodes: [
          node({ id: "d3", name: "Seasonal", isActive: false, children: [] }),
        ],
      });

      expect(screen.getByText("Hidden")).toBeInTheDocument();
    });
  });

  describe("counts", () => {
    it("shows the shop's own count and hides the register's by default", async () => {
      renderTree();
      await userEvent.click(
        screen.getByRole("button", { name: "Expand Medicines" }),
      );

      const capsule = screen.getByText("Pain & Fever").closest("li")!;
      expect(within(capsule).getByText("43")).toBeInTheDocument();
      expect(within(capsule).queryByText(/1,200/)).toBeNull();
    });

    /**
     * Both counts are pills of the same shape, so which is which cannot rest on position or
     * colour alone — each says what it counts in its accessible name.
     */
    it("adds the register's count only when asked, labelled apart from the shop's own", async () => {
      renderTree({ showReferenceCounts: true });
      await userEvent.click(
        screen.getByRole("button", { name: "Expand Medicines" }),
      );

      const capsule = screen.getByText("Pain & Fever").closest("li")!;
      expect(
        within(capsule).getByLabelText("1,200 reference-catalog products"),
      ).toHaveTextContent("1,200");
      expect(within(capsule).getByLabelText("43 products")).toHaveTextContent(
        "43",
      );
    });

    it("gives the register its own column rather than crowding the row", () => {
      renderTree({ showReferenceCounts: true });

      expect(
        screen.getByRole("columnheader", { name: "Reference" }),
      ).toBeInTheDocument();
      expect(within(rowFor("Medicines")).getByText("5,000")).toBeInTheDocument();
    });
  });

  describe("actions", () => {
    it("offers rename, add and delete by name rather than as bare icons", async () => {
      renderTree();

      await userEvent.click(
        screen.getByRole("button", { name: "Actions for Medicines" }),
      );

      expect(
        screen.getByRole("menuitem", { name: /Rename/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: /Add subcategory/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: /Delete/ }),
      ).toBeInTheDocument();
    });

    /**
     * The show/hide switch used to sit on every row, revealed on hover — twenty bright toggles
     * for a state that is almost always "on". It is a named menu item now, which is also the
     * only way it can be offered inside a table row without a column of its own.
     */
    it("offers hiding as a named action rather than a row of switches", async () => {
      const props = renderTree();

      await userEvent.click(
        screen.getByRole("button", { name: "Actions for Medicines" }),
      );
      await userEvent.click(screen.getByRole("menuitem", { name: /Hide/ }));

      expect(props.onToggleActive).toHaveBeenCalledWith(
        expect.objectContaining({ id: "d1" }),
      );
    });

    it("offers to show a hidden category again", async () => {
      renderTree({
        nodes: [node({ id: "d3", name: "Seasonal", isActive: false })],
      });

      await userEvent.click(
        screen.getByRole("button", { name: "Actions for Seasonal" }),
      );

      expect(screen.getByRole("menuitem", { name: /Show/ })).toBeInTheDocument();
    });

    /**
     * The tree renders departments and their categories, and nothing below that. Offering
     * "Add subcategory" on a subcategory created a third level that no screen then showed.
     */
    it("does not offer a subcategory its own subcategories", async () => {
      renderTree();
      await userEvent.click(
        screen.getByRole("button", { name: "Expand Medicines" }),
      );

      await userEvent.click(
        screen.getByRole("button", { name: "Actions for Pain & Fever" }),
      );

      expect(
        screen.getByRole("menuitem", { name: /Rename/ }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("menuitem", { name: /Add subcategory/ }),
      ).toBeNull();
    });

    it("says why a standard category cannot be deleted instead of just failing", async () => {
      renderTree();

      await userEvent.click(
        screen.getByRole("button", { name: "Actions for Medicines" }),
      );

      expect(
        screen.getByRole("menuitem", { name: /Delete/ }),
      ).toHaveTextContent(/Standard categories can be hidden, not deleted/);
    });

    it("offers to move products out only when there are some", async () => {
      renderTree();

      await userEvent.click(
        screen.getByRole("button", { name: "Actions for Own Brand" }),
      );

      expect(
        screen.queryByRole("menuitem", { name: /Move products out/ }),
      ).toBeNull();
    });

    it("gives a read-only caller no controls at all", () => {
      renderTree({ canWrite: false });

      expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
    });
  });

  /**
   * Opening every matching department was safe in a single narrow column; in a full-width table
   * it turns browsing into a page-length scroll of open trees. These pin the accordion and its
   * one deliberate exception.
   */
  describe("expansion", () => {
    const THREE_DEPTS: CommercialCategoryNode[] = [
      ...TREE,
      node({
        id: "d3",
        name: "Wellness",
        canonicalKey: null,
        isSystem: false,
        rangedCount: 4,
        referenceCount: 0,
        productCount: 4,
        children: [node({ id: "c3", name: "Sleep Aids", rangedCount: 4 })],
      }),
    ];

    it("closes the open department when a different one is opened", async () => {
      renderTree({ nodes: THREE_DEPTS });

      await userEvent.click(
        screen.getByRole("button", { name: "Expand Medicines" }),
      );
      expect(screen.getByText("Pain & Fever")).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: "Expand Wellness" }),
      );

      expect(screen.getByText("Sleep Aids")).toBeInTheDocument();
      expect(screen.queryByText("Pain & Fever")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Expand Medicines" }),
      ).toBeInTheDocument();
    });

    it("still opens every matching department while searching", () => {
      renderTree({ nodes: THREE_DEPTS, query: "a" });

      expect(screen.getByText("Pain & Fever")).toBeInTheDocument();
      expect(screen.getByText("Sleep Aids")).toBeInTheDocument();
    });
  });

  /**
   * A collapsed row shows a segment per subcategory instead of making "what's inside" something
   * you can only find out by opening it. Decorative (aria-hidden), so it is checked by querying
   * the DOM directly rather than through an accessible-name query.
   */
  describe("distribution bar", () => {
    const UNSORTED: CommercialCategoryNode[] = [
      node({
        id: "d9",
        name: "Wellness",
        rangedCount: 92,
        children: [
          node({ id: "s1", name: "Alpha", rangedCount: 2 }),
          node({ id: "s2", name: "Beta", rangedCount: 90 }),
          node({ id: "s3", name: "Gamma", rangedCount: 0 }),
        ],
      }),
    ];

    it("draws one segment per subcategory while collapsed", () => {
      renderTree();

      expect(
        within(groupFor("Medicines")).getAllByTestId(
          "category-distribution-segment",
        ),
      ).toHaveLength(2);
    });

    it("has none to draw for a department with no subcategories", () => {
      renderTree();

      expect(
        within(groupFor("Own Brand")).queryAllByTestId(
          "category-distribution-segment",
        ),
      ).toHaveLength(0);
    });

    /**
     * The bar is only worth reading if its widest segment and the first capsule are the same
     * subcategory, so both are ordered by product count rather than by the order the API
     * happened to return.
     */
    it("orders its segments biggest first, and shades them down that order", () => {
      renderTree({ nodes: UNSORTED });

      const segments = within(groupFor("Wellness")).getAllByTestId(
        "category-distribution-segment",
      );

      expect(segments[0]).toHaveStyle({ flexGrow: "90" });
      expect(segments[1]).toHaveStyle({ flexGrow: "2" });
      // The empty one keeps a sliver rather than vanishing.
      expect(segments[2]).toHaveStyle({ flexGrow: "0.35" });
      expect(Number(segments[0].style.opacity)).toBeGreaterThan(
        Number(segments[1].style.opacity),
      );
    });

    it("lists the capsules in that same order when opened", async () => {
      renderTree({ nodes: UNSORTED });

      await userEvent.click(
        screen.getByRole("button", { name: "Expand Wellness" }),
      );

      const names = within(groupFor("Wellness"))
        .getAllByRole("listitem")
        .map((li) => li.textContent);
      expect(names[0]).toMatch(/Beta/);
      expect(names[1]).toMatch(/Alpha/);
      expect(names[2]).toMatch(/Gamma/);
    });

    /**
     * It stayed hidden while open in the card layout this replaced. In a table it must not:
     * emptying one row's cell leaves a hole in the Distribution column exactly where the reader
     * is looking, and the bar is still the summary of the capsules listed underneath it.
     */
    it("stays on the row while it is open, so the column keeps its shape", async () => {
      renderTree();

      await userEvent.click(
        screen.getByRole("button", { name: "Expand Medicines" }),
      );

      expect(
        within(rowFor("Medicines")).getAllByTestId(
          "category-distribution-segment",
        ),
      ).toHaveLength(2);
    });
  });
});
