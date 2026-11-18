import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable, rowMenuColumn, type Column } from "./data-table";

type Row = { id: string; name: string; qty: number };

const rows: Row[] = [
  { id: "a", name: "Panadol", qty: 4 },
  { id: "b", name: "Amoxil", qty: 0 },
];

const columns: Column<Row>[] = [
  { key: "name", header: "Product", sortable: true },
  { key: "qty", header: "Stock", align: "right" },
];

describe("DataTable — default variant (existing callers)", () => {
  it("keeps the phone card layout and no list styling", () => {
    render(<DataTable columns={columns} data={rows} rowKey={(r) => r.id} />);

    const table = screen.getByRole("table");
    expect(table.className).toMatch(/phoneCards/);
    expect(table.className).not.toMatch(/\blist\b/);
    expect(table.closest("div[class*='wrap']")?.className).not.toMatch(/listWrap/);
  });

  it("still sorts client-side when no onSort is given", async () => {
    render(<DataTable columns={columns} data={rows} rowKey={(r) => r.id} />);

    await userEvent.click(screen.getByRole("columnheader", { name: /Product/ }));

    const body = screen.getAllByRole("row").slice(1);
    expect(body[0]).toHaveTextContent("Amoxil");
    expect(screen.getByRole("columnheader", { name: /Product/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });
});

describe("DataTable — list variant (#205 shared list pattern)", () => {
  it("marks the table as a list, so rows take the 44px / compact 36px heights", () => {
    render(
      <DataTable variant="list" columns={columns} data={rows} rowKey={(r) => r.id} />,
    );

    const table = screen.getByRole("table");
    expect(table.className).toMatch(/\blist\b/);
    expect(table.className).not.toMatch(/phoneCards/);
  });

  it("scrolls inside its own box on narrow screens instead of turning into cards", () => {
    render(
      <DataTable
        variant="list"
        minTableWidth="980px"
        columns={columns}
        data={rows}
        rowKey={(r) => r.id}
        noHorizontalScroll
      />,
    );

    const table = screen.getByRole("table");
    expect(table).toHaveStyle({ minWidth: "980px" });
    const scroller = table.parentElement!;
    expect(scroller.className).toMatch(/scrollArea/);
    // The phone override that let the page scroll, and the opt-out, never apply to a list.
    expect(scroller.className).not.toMatch(/phoneScroll|noHorizontalScroll/);
    expect(scroller.parentElement!.className).toMatch(/listWrap/);
  });
});

describe("rowMenuColumn", () => {
  const onEdit = jest.fn();
  const onDelete = jest.fn();
  const onOpen = jest.fn();

  function renderWithMenu(canDelete = true) {
    render(
      <DataTable
        variant="list"
        columns={[
          ...columns,
          rowMenuColumn<Row>(
            (row) => [
              ...(canDelete
                ? [{ label: "Delete", danger: true, onClick: () => onDelete(row) }]
                : []),
              { label: "Edit", onClick: () => onEdit(row) },
            ],
            (row) => row.name,
          ),
        ]}
        data={rows}
        rowKey={(r) => r.id}
        onRowClick={onOpen}
      />,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it("gives each row exactly one actions menu, named after the row", () => {
    renderWithMenu();

    // Clickable rows carry role="button", so they are found by element rather than by role.
    const [first, second] = Array.from(
      screen.getByRole("table").querySelectorAll<HTMLElement>("tbody tr"),
    );
    expect(within(first).getAllByRole("button", { name: /Actions for/ })).toHaveLength(1);
    expect(
      within(second).getByRole("button", { name: "Actions for Amoxil" }),
    ).toBeInTheDocument();
  });

  it("labels the column for screen readers without printing a header", () => {
    renderWithMenu();

    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });

  it("puts a destructive action last, behind a divider, never next to Edit", async () => {
    renderWithMenu();

    await userEvent.click(screen.getByRole("button", { name: "Actions for Panadol" }));

    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Edit", "Delete"]);
    expect(within(menu).getByRole("separator")).toBeInTheDocument();
  });

  it("does not open the row when the menu is used", async () => {
    renderWithMenu();

    await userEvent.click(screen.getByRole("button", { name: "Actions for Panadol" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));

    expect(onEdit).toHaveBeenCalledWith(rows[0]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("leaves the cell empty for a row with nothing to do", () => {
    render(
      <DataTable
        variant="list"
        columns={[...columns, rowMenuColumn<Row>(() => [], (row) => row.name)]}
        data={rows}
        rowKey={(r) => r.id}
      />,
    );

    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });
});
