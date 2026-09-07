import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryPicker } from "./category-picker";

/**
 * The single-select category tree, shared by the bulk organise dialog, the Work Queue and the
 * move-products modal. Those three used to keep three different flat `<select>`s, so what is
 * pinned here is the behaviour that made replacing them worthwhile: the hierarchy is real,
 * a chosen category is named by its whole path, and an option that would change nothing is
 * refused with a reason rather than offered.
 */
describe("CategoryPicker", () => {
  const categories = [
    { id: "med", name: "Medicines", parentCategoryId: null },
    { id: "pain", name: "Pain & Fever", parentCategoryId: "med" },
    { id: "anti", name: "Anti-infectives", parentCategoryId: "med" },
    { id: "vit", name: "Vitamins & Supplements", parentCategoryId: null },
    { id: "multi", name: "Multivitamins", parentCategoryId: "vit" },
  ];

  function setup(props: Partial<Parameters<typeof CategoryPicker>[0]> = {}) {
    const onChange = jest.fn();
    render(
      <CategoryPicker
        label="Category"
        categories={categories}
        value=""
        onChange={onChange}
        {...props}
      />,
    );
    return { onChange };
  }

  it("shows the placeholder until something is chosen", () => {
    setup();

    expect(screen.getByRole("button", { name: "Category" })).toHaveTextContent(
      "Choose a category…",
    );
  });

  it("names a chosen subcategory by its whole path, not just its last word", () => {
    setup({ value: "pain" });

    expect(screen.getByRole("button", { name: "Category" })).toHaveTextContent(
      "Medicines › Pain & Fever",
    );
  });

  it("opens to departments only — subcategories wait to be expanded", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: "Category" }));

    expect(screen.getByRole("option", { name: /Medicines/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Pain & Fever/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand Medicines" }));
    expect(
      screen.getByRole("option", { name: /Pain & Fever/ }),
    ).toBeInTheDocument();
    // Expanding one department says nothing about the others.
    expect(screen.queryByRole("option", { name: /Multivitamins/ })).toBeNull();
  });

  it("finds a subcategory by name without expanding its department first", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: "Category" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search categories" }),
      "multivit",
    );

    expect(
      screen.getByRole("option", { name: /Multivitamins/ }),
    ).toBeInTheDocument();
    // Its department comes with it, so the match is never shown without its context.
    expect(
      screen.getByRole("option", { name: /Vitamins & Supplements/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Medicines/ })).toBeNull();
  });

  it("opens onto the current answer and marks both halves of its path", async () => {
    const user = userEvent.setup();
    setup({ value: "pain" });

    await user.click(screen.getByRole("button", { name: "Category" }));

    // The department is expanded already — a chosen subcategory hidden inside a collapsed
    // department is a menu that opens showing nothing about what is currently set.
    const chosen = screen.getByRole("option", { name: /Pain & Fever/ });
    expect(chosen).toHaveAttribute("aria-selected", "true");
    // And the department it lives in is marked as containing the answer, without claiming to
    // be the answer itself.
    const department = screen.getByRole("option", { name: /Medicines/ });
    expect(department).toHaveAttribute("aria-selected", "false");
    expect(department.className).toMatch(/optionOnPath/);
  });

  it("reports the chosen id and closes", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.click(screen.getByRole("button", { name: "Category" }));
    await user.click(screen.getByRole("option", { name: /Medicines/ }));

    expect(onChange).toHaveBeenCalledWith("med");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("refuses a category that would change nothing, and says why", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({
      disabledReasons: { med: "already filed here" },
    });

    await user.click(screen.getByRole("button", { name: "Category" }));
    const option = screen.getByRole("option", { name: /Medicines/ });

    expect(option).toBeDisabled();
    expect(option).toHaveTextContent("already filed here");
    await user.click(option);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers the extra choice under the tree, since it is a category change too", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({
      extra: { value: "__unclassified__", label: "Move back to Unclassified" },
    });

    await user.click(screen.getByRole("button", { name: "Category" }));
    await user.click(
      screen.getByRole("option", { name: /Move back to Unclassified/ }),
    );

    expect(onChange).toHaveBeenCalledWith("__unclassified__");
  });
});
