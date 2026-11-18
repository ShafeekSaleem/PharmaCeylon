import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { COLUMN_META, DEFAULT_VISIBLE, PAGE_SIZE } from "../constants";
import type { ColumnKey, Product } from "../types";
import {
  distinctBrand,
  distinctGeneric,
  distinctSku,
  scheduleBadge,
  stockCell,
} from "../utils/list-cells";
import { ProductTable } from "./product-table";

function product(over: Partial<Product> = {}): Product {
  return {
    id: "p1",
    tenantId: "t1",
    sku: "SKU-100",
    source: "MANUAL",
    barcode: null,
    name: "Panadol",
    brandName: "Panadol",
    genericName: "Paracetamol",
    manufacturer: "GSK",
    dosageForm: "Tablet",
    strength: "500mg",
    unit: "tablet",
    packSize: null,
    registrationNo: "M001",
    schedule: null,
    isControlled: false,
    requiresPrescription: false,
    reorderLevel: 20,
    isActive: true,
    rangeStatus: "RANGED",
    qtyOnHand: 120,
    stockStatus: "ok",
    categories: [{ id: "c1", name: "Pain & Fever" }],
    tags: [{ id: "t1", name: "Prescription required" }],
    ...over,
  } as Product;
}

function renderTable(
  products: Product[],
  over: Partial<React.ComponentProps<typeof ProductTable>> = {},
) {
  const props = {
    products,
    total: products.length,
    loading: false,
    page: 1,
    sortBy: "",
    sortDir: "asc" as const,
    visibleColumns: new Set<ColumnKey>(DEFAULT_VISIBLE),
    canWrite: true,
    scope: "mine" as const,
    onPageChange: jest.fn(),
    onSort: jest.fn(),
    onRowClick: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    ...over,
  };
  render(<ProductTable {...props} />);
  return props;
}

function headers() {
  return screen.getAllByRole("columnheader").map((h) => h.textContent?.trim());
}

/** Clickable rows carry role="button", so rows and cells are found by element. */
function rowFor(name: string) {
  return Array.from(
    screen.getByRole("table").querySelectorAll<HTMLElement>("tbody tr"),
  ).find((r) => r.querySelector("td")?.textContent?.startsWith(name))!;
}

function cellsOf(name: string) {
  return Array.from(rowFor(name).querySelectorAll<HTMLElement>("td"));
}

/** #205, Products: the list as the redesign describes it. */
describe("Products list columns", () => {
  it("shows the default columns, with no thumbnail column and no separate Rx column", () => {
    renderTable([product()]);

    expect(headers()).toEqual([
      "Product▲",
      "SKU▲",
      "Brand▲",
      "Form / Strength",
      "Reg. no.▲",
      "Schedule▲",
      "Stock",
      "Status",
      "Actions",
    ]);
    expect(COLUMN_META.map((c) => c.key)).not.toContain("image");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("puts the generic name on a second line under the product name", () => {
    renderTable([product()]);

    const cell = cellsOf("Panadol")[0];
    expect(cell).toHaveTextContent(/^PanadolParacetamol$/);
  });

  it("shows one schedule badge and none of the old Rx tag, prescription chip or category chip", () => {
    renderTable([
      product({ id: "a", name: "Amoxil", requiresPrescription: true, schedule: "II B" }),
      product({ id: "b", name: "Morphine", isControlled: true, requiresPrescription: true, schedule: "III" }),
      product({ id: "c", name: "Panadol" }),
    ]);

    expect(within(rowFor("Amoxil")).getByText("Rx · II B")).toBeInTheDocument();
    expect(within(rowFor("Morphine")).getByText("Controlled · III")).toBeInTheDocument();
    expect(within(rowFor("Panadol")).getByText("OTC")).toBeInTheDocument();
    expect(screen.queryByText("Rx")).toBeNull();
    expect(screen.queryByText("Prescription required")).toBeNull();
    expect(screen.queryByText("Pain & Fever")).toBeNull();
  });

  it("leaves Brand blank when it repeats the name, and SKU blank when it repeats the reg. no.", () => {
    renderTable([
      product({ id: "a", name: "Panadol", brandName: "PANADOL", sku: "M001", registrationNo: "M001" }),
      product({ id: "b", name: "Amlodipine 5", brandName: "Stamlo", sku: "SKU-9", registrationNo: "M009" }),
    ]);

    const [, sku, brand] = cellsOf("Panadol");
    expect(sku).toBeEmptyDOMElement();
    expect(brand).toBeEmptyDOMElement();
    const other = cellsOf("Amlodipine 5");
    expect(other[1]).toHaveTextContent("SKU-9");
    expect(other[2]).toHaveTextContent("Stamlo");
  });

  it("shows stock as a number with a short note, and colours only zero and low", () => {
    renderTable([
      product({ id: "a", name: "Healthy", qtyOnHand: 120, stockStatus: "ok" }),
      product({ id: "b", name: "Lowish", qtyOnHand: 8, stockStatus: "low" }),
      product({ id: "c", name: "Empty", qtyOnHand: 0, stockStatus: "out" }),
    ]);

    const stockOf = (name: string) => cellsOf(name)[6];
    expect(stockOf("Healthy")).toHaveTextContent("120Reorder at 20");
    expect(stockOf("Healthy").firstElementChild!.className).not.toMatch(/stockLow|stockOut/);
    expect(stockOf("Lowish")).toHaveTextContent("8Low · reorder at 20");
    expect(stockOf("Lowish").firstElementChild!.className).toMatch(/stockLow/);
    expect(stockOf("Empty")).toHaveTextContent("0Out of stock");
    expect(stockOf("Empty").firstElementChild!.className).toMatch(/stockOut/);
  });

  it("shows only Inactive in the Status column", () => {
    renderTable([
      product({ id: "a", name: "On sale", isActive: true }),
      product({ id: "b", name: "Delisted", isActive: false }),
    ]);

    expect(within(rowFor("On sale")).queryByText(/active/i)).toBeNull();
    expect(within(rowFor("Delisted")).getByText("Inactive")).toBeInTheDocument();
  });

  it("offers one actions menu per row, with Delete last and apart from Edit", async () => {
    const props = renderTable([product()]);

    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Panadol" }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["Edit product", "Delete product"]);
    expect(screen.getByRole("separator")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("menuitem", { name: "Delete product" }));
    expect(props.onDelete).toHaveBeenCalled();
    expect(props.onRowClick).not.toHaveBeenCalled();
  });

  it("drops Delete for someone without the delete permission, and the menu for read-only users", async () => {
    renderTable([product()], { canDelete: false });
    await userEvent.click(screen.getByRole("button", { name: "Actions for Panadol" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Edit product"]);
  });

  it("shows no actions menu to a user who cannot write", () => {
    renderTable([product()], { canWrite: false });
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("uses the shared list pattern table", () => {
    renderTable([product()]);
    expect(screen.getByRole("table").className).toMatch(/\blist\b/);
  });

  it("asks for enough rows to fill a 1440 × 900 screen", () => {
    expect(PAGE_SIZE).toBeGreaterThanOrEqual(15);
  });
});

describe("Products list cell rules", () => {
  it.each([
    [{ isControlled: false, requiresPrescription: false, schedule: null }, "OTC", "otc"],
    [{ isControlled: false, requiresPrescription: false, schedule: "IV" }, "OTC", "otc"],
    [{ isControlled: false, requiresPrescription: true, schedule: "II B" }, "Rx · II B", "rx"],
    [{ isControlled: false, requiresPrescription: true, schedule: null }, "Rx", "rx"],
    [{ isControlled: true, requiresPrescription: true, schedule: "III" }, "Controlled · III", "controlled"],
    [{ isControlled: true, requiresPrescription: false, schedule: " " }, "Controlled", "controlled"],
  ])("schedule badge for %j is %s", (row, label, kind) => {
    const info = scheduleBadge(row);
    expect(info.label).toBe(label);
    expect(info.kind).toBe(kind);
  });

  it("compares duplicates without caring about case or spaces", () => {
    expect(distinctBrand({ name: "Panadol", brandName: " panadol " })).toBeNull();
    expect(distinctBrand({ name: "Panadol", brandName: null })).toBeNull();
    expect(distinctBrand({ name: "Panadol 500", brandName: "Panadol" })).toBe("Panadol");
    expect(distinctSku({ sku: "m001", registrationNo: "M001" })).toBeNull();
    expect(distinctSku({ sku: "SKU-1", registrationNo: null })).toBe("SKU-1");
    expect(distinctGeneric({ name: "Paracetamol", genericName: "paracetamol" })).toBeNull();
  });

  it("says why stock is blank when no branch is selected", () => {
    expect(
      stockCell({ qtyOnHand: null, stockStatus: null, reorderLevel: 0, reorderGap: null }),
    ).toEqual(expect.objectContaining({ qty: null, tone: null }));
  });

  it("states low and out in words, not only colour", () => {
    expect(
      stockCell({ qtyOnHand: 3, stockStatus: "low", reorderLevel: 0, reorderGap: null }),
    ).toEqual(expect.objectContaining({ tone: "low", note: "Low" }));
    expect(
      stockCell({ qtyOnHand: 0, stockStatus: "out", reorderLevel: 10, reorderGap: 10 }),
    ).toEqual(expect.objectContaining({ tone: "out", note: "Out of stock" }));
    expect(
      stockCell({ qtyOnHand: 50, stockStatus: "ok", reorderLevel: 0, reorderGap: null }),
    ).toEqual(expect.objectContaining({ tone: null, note: null }));
  });
});
