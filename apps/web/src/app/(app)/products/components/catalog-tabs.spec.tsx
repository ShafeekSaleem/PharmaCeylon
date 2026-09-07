import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogTabs } from "./catalog-tabs";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: React.ComponentProps<"a">) => (
    <a href={href as string} {...rest}>
      {children}
    </a>
  ),
}));

/**
 * Products used to carry six equal tabs. Four of them were catalog administration and one of
 * them — Register matches — was a worklist, sitting in the same row as the product list a
 * cashier opens fifty times a day. These tests pin the two that are left, and the permission
 * split that made merging Search Catalog in safe.
 */
describe("CatalogTabs", () => {
  it("shows exactly two tabs", () => {
    render(
      <CatalogTabs active="mine" rangedCount={106} referenceCount={6589} />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAccessibleName(/My products/);
    expect(tabs[1]).toHaveAccessibleName(/Reference catalog/);
  });

  it.each(["Categories", "Tags", "Organize", "Register matches"])(
    "no longer offers %s as a primary tab",
    (label) => {
      render(
        <CatalogTabs active="mine" rangedCount={106} referenceCount={6589} />,
      );
      expect(
        screen.queryByRole("tab", { name: new RegExp(label, "i") }),
      ).toBeNull();
    },
  );

  it("says what each count is, so a screen reader hears more than two bare numbers", () => {
    render(
      <CatalogTabs active="mine" rangedCount={106} referenceCount={6589} />,
    );

    expect(
      screen.getByRole("tab", {
        name: "My products, 106 products in your range",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", {
        name: "Reference catalog, 6,589 medicines on the NMRA register",
      }),
    ).toBeInTheDocument();
  });

  it("marks the active scope selected", () => {
    render(
      <CatalogTabs active="reference" rangedCount={1} referenceCount={2} />,
    );

    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(
      /Reference catalog/,
    );
  });

  it("switches scope in place when the page handles it, rather than navigating", async () => {
    const onScopeChange = jest.fn();
    render(
      <CatalogTabs
        active="mine"
        rangedCount={1}
        referenceCount={2}
        onScopeChange={onScopeChange}
      />,
    );

    await userEvent.click(
      screen.getByRole("tab", { name: /Reference catalog/ }),
    );

    expect(onScopeChange).toHaveBeenCalledWith("reference");
  });

  it("falls back to links when there is no in-place handler", () => {
    render(<CatalogTabs active="mine" rangedCount={1} referenceCount={2} />);

    expect(
      screen.getByRole("tab", { name: /Reference catalog/ }),
    ).toHaveAttribute("href", "/products?scope=reference");
  });

  /**
   * Search Catalog (`catalog.view`) folded into the Reference tab. Both keys default to all
   * five roles, but a tenant that granted one and not the other must not lose a screen to a
   * consolidation — so each scope is gated on its own.
   */
  describe("permission-scoped tabs", () => {
    it("hides My products from a caller with only catalog.view", () => {
      render(
        <CatalogTabs active="reference" canViewMine={false} canViewReference />,
      );

      expect(screen.getAllByRole("tab")).toHaveLength(1);
      expect(screen.getByRole("tab")).toHaveAccessibleName(/Reference catalog/);
    });

    it("hides the Reference tab from a caller without catalog.view", () => {
      render(
        <CatalogTabs active="mine" canViewMine canViewReference={false} />,
      );

      expect(screen.getAllByRole("tab")).toHaveLength(1);
      expect(screen.getByRole("tab")).toHaveAccessibleName(/My products/);
    });
  });
});
