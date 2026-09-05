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
    onMove: jest.fn(),
    onMoveProducts: jest.fn(),
    ...over,
  };
  render(<CategoryTree {...props} />);
  return props;
}

/**
 * The tree was one flat list of forty near-identical rows, each carrying a "Standard" chip and
 * four always-on controls. These tests pin the three things that fixed it, because each is easy
 * to undo by accident: departments summarise and start closed, only the informative chips are
 * drawn, and the counts a shop cares about are its own.
 */
describe("CategoryTree", () => {
  it("starts closed, showing departments rather than every category", () => {
    renderTree();

    expect(
      screen.getByRole("heading", { name: "Medicines" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Pain & Fever")).toBeNull();
  });

  it("summarises what is inside a closed department", () => {
    renderTree();

    const medicines = screen.getByRole("heading", {
      name: "Medicines",
    }).parentElement!;
    expect(medicines).toHaveTextContent(/2 categories/);
    expect(medicines).toHaveTextContent(/745 products/);
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

    expect(screen.queryByRole("heading", { name: "Own Brand" })).toBeNull();
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

      const row = screen.getByText("Pain & Fever").closest("li")!;
      expect(within(row).getByText("43")).toBeInTheDocument();
      expect(within(row).queryByText(/1,200/)).toBeNull();
    });

    it("adds the register's count only when asked", async () => {
      renderTree({ showReferenceCounts: true });
      await userEvent.click(
        screen.getByRole("button", { name: "Expand Medicines" }),
      );

      const row = screen.getByText("Pain & Fever").closest("li")!;
      expect(within(row).getByText(/1,200 ref/)).toBeInTheDocument();
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
      expect(screen.queryByRole("switch")).toBeNull();
    });

    it("reorders against its siblings", async () => {
      const props = renderTree();
      await userEvent.click(
        screen.getByRole("button", { name: "Expand Medicines" }),
      );

      await userEvent.click(
        screen.getByRole("button", { name: /Move Cold, Cough & Allergy up/ }),
      );

      expect(props.onMove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "c2" }),
        "up",
        expect.arrayContaining([expect.objectContaining({ id: "c1" })]),
      );
    });

    it("cannot move the first sibling up", async () => {
      renderTree();
      await userEvent.click(
        screen.getByRole("button", { name: "Expand Medicines" }),
      );

      expect(
        screen.getByRole("button", { name: /Move Pain & Fever up/ }),
      ).toBeDisabled();
    });
  });

  it("says so when nothing matches", () => {
    renderTree({ query: "zzz" });

    expect(screen.getByText("No categories match.")).toBeInTheDocument();
  });
});
