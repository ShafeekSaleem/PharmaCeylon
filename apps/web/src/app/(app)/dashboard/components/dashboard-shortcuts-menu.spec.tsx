import { fireEvent, render, screen } from "@testing-library/react";
import { OWNER_DASHBOARD_SHORTCUTS } from "../lib/dashboard-shortcuts";
import { DashboardShortcutsMenu } from "./dashboard-shortcuts-menu";
import { PosHiddenContext } from "../lib/pos-links";

jest.mock("@/components/role-access", () => ({
  RoleLink: ({
    href,
    children,
    className,
    onClick,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
  }) => (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  ),
}));

describe("DashboardShortcutsMenu", () => {
  it("exposes all eight shortcuts in the menu", () => {
    render(
      <PosHiddenContext.Provider value={false}>
        <DashboardShortcutsMenu actions={OWNER_DASHBOARD_SHORTCUTS} />
      </PosHiddenContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Shortcuts/i }));
    expect(
      screen.getAllByRole("link", { name: /PO|stock|expiry|transfer|Return|movements/i }),
    ).toHaveLength(8);
    expect(screen.getByRole("link", { name: /Create PO/i })).toHaveAttribute(
      "href",
      "/purchasing?action=create-po",
    );
    expect(screen.getByRole("link", { name: /Return approvals/i })).toHaveAttribute(
      "href",
      "/returns?status=pending_approval",
    );
  });
});