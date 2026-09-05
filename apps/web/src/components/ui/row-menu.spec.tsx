import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RowMenu } from "./row-menu";

/**
 * Categories, Tags and the Work Queue each independently grew a row of four to six unlabeled
 * icon buttons, two of them destructive. This is the one menu they now share, so the things it
 * has to get right — named items, a distinguishable destructive one, and not firing whatever is
 * behind it — are pinned once here.
 */
describe("RowMenu", () => {
  const actions = [
    { label: "Rename", onClick: jest.fn() },
    { label: "Delete", danger: true, separated: true, onClick: jest.fn(), hint: "Removes it from 4 products" },
  ];

  it("renders nothing when there is nothing to do", () => {
    const { container } = render(<RowMenu label="Pain & Fever" actions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names its trigger after the row, so a page of them is not twenty identical buttons", () => {
    render(<RowMenu label="Pain & Fever" actions={actions} />);

    expect(screen.getByRole("button", { name: "Actions for Pain & Fever" })).toBeInTheDocument();
  });

  it("keeps the menu closed until asked", () => {
    render(<RowMenu label="Pain & Fever" actions={actions} />);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: /Actions for/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("opens to named items rather than icons", async () => {
    render(<RowMenu label="Pain & Fever" actions={actions} />);

    await userEvent.click(screen.getByRole("button", { name: /Actions for/ }));

    expect(screen.getByRole("menuitem", { name: /Rename/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Delete/ })).toBeInTheDocument();
  });

  it("shows the hint that says what a destructive action will actually take with it", async () => {
    render(<RowMenu label="Pain & Fever" actions={actions} />);

    await userEvent.click(screen.getByRole("button", { name: /Actions for/ }));

    expect(screen.getByRole("menuitem", { name: /Delete/ })).toHaveTextContent(
      "Removes it from 4 products",
    );
  });

  it("runs the action and closes", async () => {
    const onClick = jest.fn();
    render(<RowMenu label="Pain & Fever" actions={[{ label: "Rename", onClick }]} />);

    await userEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape", async () => {
    render(<RowMenu label="Pain & Fever" actions={actions} />);

    await userEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a click outside", async () => {
    render(
      <div>
        <RowMenu label="Pain & Fever" actions={actions} />
        <button type="button">Elsewhere</button>
      </div>,
    );

    await userEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  /**
   * These sit inside rows that are themselves clickable — a Work Queue row opens the product,
   * a category row toggles its department. Opening the menu must not also do that.
   */
  it("does not fire the clickable row behind it", async () => {
    const onRowClick = jest.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
      <div onClick={onRowClick}>
        <RowMenu label="Pain & Fever" actions={actions} />
      </div>,
    );

    await userEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    expect(onRowClick).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("does not offer a disabled action", async () => {
    render(
      <RowMenu
        label="Pain & Fever"
        actions={[{ label: "Delete", onClick: jest.fn(), disabled: true }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Actions for/ }));

    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
  });
});
