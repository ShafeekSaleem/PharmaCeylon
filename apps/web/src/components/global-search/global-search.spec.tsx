import { fireEvent, render, screen } from "@testing-library/react";
import { GlobalSearch } from "./global-search";

jest.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));

const KEYS = ["sales.pos_use", "purchasing.manage", "transfers.manage", "inventory.view"];

function open(posHidden?: boolean) {
  render(<GlobalSearch permissionKeys={KEYS} posHidden={posHidden} />);
  fireEvent.focus(screen.getByLabelText("Search products, sales, suppliers and more"));
}

beforeEach(() => localStorage.clear());

describe("GlobalSearch POS action", () => {
  it("offers Start a new sale at a branch that isn't live", () => {
    open();
    expect(screen.getByText("Start a new sale")).toBeInTheDocument();
    expect(screen.getByText("Create purchase order")).toBeInTheDocument();
  });

  it("drops it, and any recent POS entry, once desktop POS is live", () => {
    localStorage.setItem(
      "pc_global_search_recent",
      JSON.stringify([
        {
          id: "new-sale",
          type: "action",
          title: "Start a new sale",
          subtitle: "Open POS / Checkout",
          href: "/pos",
          permission: "sales.pos_use",
        },
      ]),
    );
    open(true);
    expect(screen.queryByText("Start a new sale")).not.toBeInTheDocument();
    expect(screen.getByText("Create purchase order")).toBeInTheDocument();
  });
});
