import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReferenceAddPreview } from "../api/catalog-tasks";
import type { Product } from "../types";
import { ProductTable } from "./product-table";
import { ReferenceAddReviewModal } from "./reference-add-review-modal";

const COLUMNS = new Set(["name", "actions"]) as Set<never>;

function product(over: Partial<Product> = {}): Product {
  return {
    id: "ref-1",
    tenantId: "t1",
    sku: "SKU1",
    source: "NMRA",
    barcode: null,
    name: "STAMLO 5",
    brandName: "STAMLO",
    genericName: "Amlodipine",
    manufacturer: null,
    dosageForm: "Tablet",
    strength: "5mg",
    unit: null,
    packSize: null,
    registrationNo: "M016695",
    schedule: "IIB",
    isControlled: false,
    requiresPrescription: true,
    reorderLevel: 0,
    isActive: true,
    rangeStatus: "REFERENCE",
    ...over,
  } as Product;
}

function renderTable(over: Partial<React.ComponentProps<typeof ProductTable>> = {}) {
  const props = {
    products: [product()],
    total: 1,
    loading: false,
    page: 1,
    sortBy: "",
    sortDir: "asc" as const,
    visibleColumns: COLUMNS,
    canWrite: true,
    scope: "reference" as const,
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

/**
 * A reference row is the regulator's record. Offering Edit and Delete on one implied the shop
 * could change the NMRA register, and Delete on a claimed row would have stranded its link
 * history — which the new foreign key now refuses outright. The only action that makes sense
 * on a register row is starting to sell it.
 */
describe("ProductTable — reference rows", () => {
  it("offers Add, not edit or delete", () => {
    renderTable({ onAddReference: jest.fn() });

    expect(screen.getByRole("button", { name: "Add STAMLO 5 to my products" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("calls back with the row when Add is pressed", async () => {
    const onAddReference = jest.fn();
    renderTable({ onAddReference });

    await userEvent.click(screen.getByRole("button", { name: /Add STAMLO 5/ }));

    expect(onAddReference).toHaveBeenCalledWith(expect.objectContaining({ id: "ref-1" }));
  });

  it("does not also open the row's detail panel when Add is pressed", async () => {
    const onAddReference = jest.fn();
    const onRowClick = jest.fn();
    renderTable({ onAddReference, onRowClick });

    await userEvent.click(screen.getByRole("button", { name: /Add STAMLO 5/ }));

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("shows a state, not a button, once a row has been added", () => {
    renderTable({ onAddReference: jest.fn(), addedReferenceIds: new Set(["ref-1"]) });

    expect(screen.getByText("In my products")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add STAMLO 5/ })).toBeNull();
  });

  it("disables the button while that row is being added", () => {
    renderTable({ onAddReference: jest.fn(), addingReferenceId: "ref-1" });

    expect(screen.getByRole("button", { name: /Add STAMLO 5/ })).toBeDisabled();
  });

  it("offers nothing to a read-only caller", () => {
    renderTable({ onAddReference: jest.fn(), canWrite: false });

    expect(screen.queryByRole("button", { name: /Add STAMLO 5/ })).toBeNull();
  });

  it("keeps edit and delete for the shop's own products", () => {
    renderTable({ scope: "mine", products: [product({ rangeStatus: "RANGED" })] });

    expect(screen.queryByRole("button", { name: /to my products/ })).toBeNull();
  });
});

/**
 * The lightweight review. It must not appear for the ordinary case — adding a medicine the
 * shop doesn't have has to stay one click — and must appear when adding would create a second
 * record for one real medicine.
 */
describe("ReferenceAddReviewModal", () => {
  const preview = (over: Partial<ReferenceAddPreview> = {}): ReferenceAddPreview => ({
    items: [
      {
        referenceProductId: "ref-1",
        name: "STAMLO 5",
        allowed: true,
        needsReview: true,
        reason: null,
        warnings: ['You already sell "Amlodipine 5mg", which has the same barcode.'],
      },
    ],
    addable: 1,
    needsReview: 1,
    blocked: 0,
    ...over,
  });

  it("names the duplicate it found", () => {
    render(
      <ReferenceAddReviewModal
        open
        preview={preview()}
        applying={false}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveTextContent(
      /You already sell "Amlodipine 5mg", which has the same barcode/,
    );
  });

  it("lists blocked rows separately and says they will be skipped", () => {
    render(
      <ReferenceAddReviewModal
        open
        preview={preview({
          items: [
            {
              referenceProductId: "ref-2",
              name: "NORVASC 5",
              allowed: false,
              needsReview: false,
              reason: "NORVASC 5 is already linked to one of your products.",
              warnings: [],
            },
          ],
          addable: 0,
          needsReview: 0,
          blocked: 1,
        })}
        applying={false}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/1 cannot be added and will be skipped/);
    expect(dialog).toHaveTextContent(/already linked to one of your products/);
  });

  it("states how many will be added on the confirm button", () => {
    render(
      <ReferenceAddReviewModal
        open
        preview={preview({ addable: 12 })}
        applying={false}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Add 12 products" })).toBeInTheDocument();
  });

  it("has nothing to confirm when everything is blocked", () => {
    render(
      <ReferenceAddReviewModal
        open
        preview={preview({ addable: 0, needsReview: 0, blocked: 1 })}
        applying={false}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Add 0 products/ })).toBeDisabled();
  });

  it("confirms and cancels through its callbacks", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(
      <ReferenceAddReviewModal
        open
        preview={preview()}
        applying={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Add 1 product/ }));
    expect(onConfirm).toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("locks both buttons while the add is in flight", () => {
    render(
      <ReferenceAddReviewModal
        open
        preview={preview()}
        applying
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
