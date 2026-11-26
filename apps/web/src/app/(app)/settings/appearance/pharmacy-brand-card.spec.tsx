import { createRef } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import {
  DEFAULT_PHARMACY_APPEARANCE,
  type PharmacyAppearance,
} from "@pharmaceylon/shared";
import { ApiError } from "@/lib/api-error";
import type { AuthUser } from "@/lib/auth-types";
import { PharmacyBrandCard, type PharmacyBrandHandle } from "./pharmacy-brand-card";

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

// The card has no save button of its own: the Appearance page saves it through this handle.
const handle = createRef<PharmacyBrandHandle>();
const onState = jest.fn();

async function renderCard(role: string) {
  render(<PharmacyBrandCard ref={handle} user={asRole(role)} onStateChange={onState} />);
  await act(async () => {});
}

async function save(): Promise<boolean | undefined> {
  let result: boolean | undefined;
  await act(async () => {
    result = await handle.current?.save();
  });
  return result;
}

const lastState = () => onState.mock.calls.at(-1)?.[0];

beforeEach(() => {
  onState.mockReset();
  fetchBrand.mockReset().mockResolvedValue(stored());
  saveBrand.mockReset();
  document.getElementById("pc-brand")?.remove();
  delete document.documentElement.dataset.sidebar;
  delete document.documentElement.dataset.chart;
});

it("shows non-owners the brand without letting them change it", async () => {
  await renderCard("manager");
  expect(screen.getByText("Only an owner can change this")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Ocean accent" })).toBeDisabled();
  // Nothing to save for a non-owner, so the page's Save never sends the brand.
  expect(await save()).toBe(true);
  expect(saveBrand).not.toHaveBeenCalled();
  expect(lastState()).toEqual({ dirty: false, invalid: false });
});

it("previews a choice, then saves it on the version the owner loaded", async () => {
  saveBrand.mockImplementation(async (_v, a) =>
    stored({ ...(a as object), version: 4 }),
  );
  await renderCard("owner");
  fireEvent.click(screen.getByRole("button", { name: "Ocean accent" }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "Sidebar" })).getByRole("button", {
      name: "Dark",
    }),
  );
  expect(document.getElementById("pc-brand")?.textContent).toContain("#1d5fa8");
  expect(document.documentElement.dataset.sidebar).toBe("dark");
  await save();
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
  // The page disables Save while a colour can't be saved; the handle refuses it too.
  expect(lastState()).toEqual(expect.objectContaining({ invalid: true }));
  expect(await save()).toBe(false);
  expect(saveBrand).not.toHaveBeenCalled();
});

it("tells the page when the owner has unsaved changes", async () => {
  await renderCard("owner");
  expect(lastState()).toEqual({ dirty: false, invalid: false });
  fireEvent.click(screen.getByRole("button", { name: "Ocean accent" }));
  expect(lastState()).toEqual({ dirty: true, invalid: false });
});

it("puts the PharmaCeylon defaults in the form for the owner to save", async () => {
  fetchBrand.mockResolvedValue(stored({ accent: "#86198f", sidebarStyle: "dark" }));
  saveBrand.mockImplementation(async (_v, a) => stored({ ...(a as object), version: 4 }));
  await renderCard("owner");
  act(() => handle.current?.resetToDefaults());
  expect(screen.getByRole("button", { name: "Teal accent" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(saveBrand).not.toHaveBeenCalled();
  await save();
  expect(saveBrand).toHaveBeenCalledWith(3, expect.objectContaining(DEFAULT_PHARMACY_APPEARANCE));
});

it("puts the saved brand back when the owner leaves without saving", async () => {
  const { unmount } = render(<PharmacyBrandCard ref={handle} user={asRole("owner")} />);
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
  await save();
  expect(
    screen.getByText(/Another owner changed the brand/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Indigo accent" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("sets the counter app's starting theme and locks it", async () => {
  saveBrand.mockImplementation(async (_v, a) =>
    stored({ ...(a as object), version: 4 }),
  );
  await renderCard("owner");
  const counter = within(
    screen.getByRole("group", { name: "Counter app theme" }),
  );
  fireEvent.click(counter.getByRole("button", { name: "Dark" }));
  fireEvent.click(
    screen.getByRole("switch", { name: "Lock it on every counter" }),
  );
  await save();
  expect(saveBrand).toHaveBeenCalledWith(
    3,
    expect.objectContaining({ counterTheme: "dark", counterThemeLocked: true }),
  );
});

it("lets the owner pick the distinct chart colours", async () => {
  saveBrand.mockImplementation(async (_v, a) =>
    stored({ ...(a as object), version: 4 }),
  );
  await renderCard("owner");
  fireEvent.click(screen.getByRole("button", { name: "Distinct colours" }));
  expect(document.documentElement.dataset.chart).toBe("distinct");
  await save();
  expect(saveBrand).toHaveBeenCalledWith(
    3,
    expect.objectContaining({ chartPalette: "distinct" }),
  );
});
