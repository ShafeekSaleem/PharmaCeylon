import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_PHARMACY_APPEARANCE,
  type PharmacyAppearance,
} from "@pharmaceylon/shared";
import { ApiError } from "@/lib/api-error";
import type { AuthUser } from "@/lib/auth-types";
import { PharmacyBrandCard } from "./pharmacy-brand-card";

const fetchBrand = jest.fn<Promise<PharmacyAppearance>, []>();
const saveBrand = jest.fn<Promise<PharmacyAppearance>, [number, unknown]>();
jest.mock("@/lib/pharmacy-brand", () => ({
  ...jest.requireActual("@/lib/pharmacy-brand"),
  fetchPharmacyBrand: () => fetchBrand(),
  savePharmacyBrand: (v: number, a: unknown) => saveBrand(v, a),
}));

const stored = (
  over: Partial<PharmacyAppearance> = {},
): PharmacyAppearance => ({
  ...DEFAULT_PHARMACY_APPEARANCE,
  version: 3,
  updatedAt: "2026-11-19T08:00:00Z",
  ...over,
});

const asRole = (role: string) =>
  ({
    id: "u1",
    branchRoles: [{ branchId: "b1", role }],
  }) as unknown as AuthUser;

async function renderCard(role: string) {
  render(<PharmacyBrandCard user={asRole(role)} />);
  await act(async () => {});
}

beforeEach(() => {
  fetchBrand.mockReset().mockResolvedValue(stored());
  saveBrand.mockReset();
  document.getElementById("pc-brand")?.remove();
  delete document.documentElement.dataset.sidebar;
});

it("shows non-owners the brand without letting them change it", async () => {
  await renderCard("manager");
  expect(screen.getByText("Only an owner can change this")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Ocean accent" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save for the pharmacy" }),
  ).toBeNull();
});

it("previews a choice, then saves it on the version the owner loaded", async () => {
  saveBrand.mockImplementation(async (_v, a) =>
    stored({ ...(a as object), version: 4 }),
  );
  await renderCard("owner");
  fireEvent.click(screen.getByRole("button", { name: "Ocean accent" }));
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  expect(document.getElementById("pc-brand")?.textContent).toContain("#1d5fa8");
  expect(document.documentElement.dataset.sidebar).toBe("dark");
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Save for the pharmacy" }),
    );
  });
  expect(saveBrand).toHaveBeenCalledWith(
    3,
    expect.objectContaining({ accent: "#1d5fa8", sidebarStyle: "dark" }),
  );
  expect(
    screen.getByText("Saved for everyone at the pharmacy."),
  ).toBeInTheDocument();
});

it("refuses an unreadable custom colour with the API's words", async () => {
  await renderCard("owner");
  fireEvent.change(screen.getByLabelText("Or your own colour"), {
    target: { value: "#0d9488" },
  });
  expect(screen.getByText(/Too light to read: 3\.\d\d:1/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save for the pharmacy" }),
  ).toBeDisabled();
});

it("puts the saved brand back when the owner leaves without saving", async () => {
  const { unmount } = render(<PharmacyBrandCard user={asRole("owner")} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Plum accent" }));
  expect(document.getElementById("pc-brand")).not.toBeNull();
  unmount();
  expect(document.getElementById("pc-brand")).toBeNull();
});

it("shows the other owner's version after a conflicting save", async () => {
  saveBrand.mockRejectedValue(new ApiError("stale", 409, null));
  await renderCard("owner");
  fetchBrand.mockResolvedValue(stored({ accent: "#4338ca", version: 4 }));
  fireEvent.click(screen.getByRole("button", { name: "Ocean accent" }));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Save for the pharmacy" }),
    );
  });
  expect(
    screen.getByText(/Another owner changed the brand/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Indigo accent" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
