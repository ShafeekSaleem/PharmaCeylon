import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogTabs } from "./catalog-tabs";
import { CatalogIssueBanner } from "./catalog-issue-banner";
import type { CatalogTaskSummary } from "../api/catalog-tasks";

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

/**
 * The banner that replaced five permanently-visible KPI cards. Its whole value is that it is
 * usually absent — a shop with a clean catalog should see nothing at all.
 */
describe("CatalogIssueBanner", () => {
  const summary = (
    over: Partial<CatalogTaskSummary> = {},
  ): CatalogTaskSummary => ({
    open: 8,
    needsCategory: 3,
    nmraMatch: 5,
    complianceReview: 0,
    ambiguous: 0,
    noSuggestion: 0,
    safeToApply: 4,
    fromRecentImports: 0,
    resolved: 0,
    dismissed: 0,
    notApplicable: 0,
    categoryCoveragePercent: 92,
    ...over,
  });

  it("renders nothing when there is no outstanding work", () => {
    const { container } = render(
      <CatalogIssueBanner summary={summary({ open: 0 })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing before the summary has loaded", () => {
    const { container } = render(<CatalogIssueBanner summary={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("breaks the total down instead of stating a bare number", () => {
    render(<CatalogIssueBanner summary={summary()} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      /8 products need catalog review.*3 missing a category.*5 possible NMRA matches/,
    );
  });

  it("calls out compliance-sensitive work separately", () => {
    render(<CatalogIssueBanner summary={summary({ complianceReview: 2 })} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      /2 would change a compliance flag and need individual review/,
    );
  });

  it("links into the queue", () => {
    render(<CatalogIssueBanner summary={summary()} />);

    expect(screen.getByRole("link", { name: /Review tasks/ })).toHaveAttribute(
      "href",
      "/products/manage",
    );
  });
});
