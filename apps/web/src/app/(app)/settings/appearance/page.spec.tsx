import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_PHARMACY_APPEARANCE, type PharmacyAppearance } from "@pharmaceylon/shared";
import {
  APPEARANCE_CHANGED_EVENT,
  readAppearancePrefs,
  saveAppearancePrefs,
} from "@/lib/appearance";
import AppearancePage from "./page";

const fetchBrand = jest.fn<Promise<PharmacyAppearance>, []>();
const saveBrand = jest.fn<Promise<PharmacyAppearance>, [number, unknown]>();
jest.mock("@/lib/pharmacy-brand", () => ({
  ...jest.requireActual("@/lib/pharmacy-brand"),
  fetchPharmacyBrand: () => fetchBrand(),
  savePharmacyBrand: (v: number, a: unknown) => saveBrand(v, a),
}));

let role = "manager";
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({ user: { id: "u-1", branchRoles: [{ branchId: "b1", role }] } }),
}));

const stored = (over: Partial<PharmacyAppearance> = {}): PharmacyAppearance => ({
  ...DEFAULT_PHARMACY_APPEARANCE,
  version: 3,
  updatedAt: null,
  ...over,
});

const root = document.documentElement;
const group = (name: string) => within(screen.getByRole("group", { name }));
const saveButton = () => screen.getByRole("button", { name: "Save changes" });

async function renderPage() {
  const view = render(<AppearancePage />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  role = "manager";
  localStorage.clear();
  delete root.dataset.theme;
  delete root.dataset.density;
  root.style.fontSize = "";
  fetchBrand.mockReset().mockResolvedValue(stored());
  saveBrand.mockReset();
});

describe("Your display", () => {
  it("shows a choice on the page straight away and keeps it only on Save", async () => {
    await renderPage();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(group("Theme").getByRole("button", { name: "Dark" }));
    fireEvent.click(group("Density").getByRole("button", { name: "Compact" }));
    fireEvent.click(group("Text size").getByRole("button", { name: "Large" }));

    // Live on the page already…
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.density).toBe("compact");
    expect(root.style.fontSize).toBe("17px");
    expect(group("Theme").getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // …but not saved.
    expect(readAppearancePrefs("u-1").theme).toBe("system");
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");

    fireEvent.click(saveButton());
    await act(async () => {});
    expect(readAppearancePrefs("u-1")).toEqual({
      theme: "dark",
      density: "compact",
      fontSize: "large",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    expect(saveButton()).toBeDisabled();
    // A manager has no brand to save.
    expect(saveBrand).not.toHaveBeenCalled();
  });

  it("puts the saved display back when leaving without saving", async () => {
    saveAppearancePrefs({ theme: "light", density: "comfortable", fontSize: "medium" }, "u-1");
    const { unmount } = await renderPage();
    fireEvent.click(group("Theme").getByRole("button", { name: "Dark" }));
    expect(root.dataset.theme).toBe("dark");
    unmount();
    expect(root.dataset.theme).toBe("light");
  });

  it("resets to the defaults as a draft, saved only on Save", async () => {
    saveAppearancePrefs({ theme: "dark", density: "compact", fontSize: "small" }, "u-1");
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(group("Theme").getByRole("button", { name: "Match device" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(group("Text size").getByRole("button", { name: "Default" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(readAppearancePrefs("u-1").theme).toBe("dark");
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(readAppearancePrefs("u-1")).toEqual({
      theme: "system",
      density: "comfortable",
      fontSize: "medium",
    });
  });

  it("takes the theme from the top-bar switch without losing other unsaved choices", async () => {
    await renderPage();
    fireEvent.click(group("Density").getByRole("button", { name: "Compact" }));
    act(() => {
      window.dispatchEvent(
        new CustomEvent(APPEARANCE_CHANGED_EVENT, {
          detail: { theme: "dark", density: "comfortable", fontSize: "medium" },
        }),
      );
    });
    expect(group("Theme").getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(group("Density").getByRole("button", { name: "Compact" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  });

  it("asks before following a link away from unsaved changes", async () => {
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
    await renderPage();
    const link = document.createElement("a");
    link.href = "/dashboard";
    link.textContent = "Dashboard";
    document.body.appendChild(link);

    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(group("Density").getByRole("button", { name: "Compact" }));
    fireEvent.click(link);
    expect(confirm).toHaveBeenCalledTimes(1);
    link.remove();
    confirm.mockRestore();
  });
});

describe("one save model with the pharmacy brand", () => {
  it("saves the owner's brand change with the same Save", async () => {
    role = "owner";
    saveBrand.mockImplementation(async (_v, a) => stored({ ...(a as object), version: 4 }));
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Ocean accent" }));
    expect(saveButton()).toBeEnabled();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(saveBrand).toHaveBeenCalledWith(3, expect.objectContaining({ accent: "#1d5fa8" }));
    expect(screen.getByText("Saved for everyone at the pharmacy.")).toBeInTheDocument();
  });

  it("keeps Save off while the owner's custom colour can't be saved", async () => {
    role = "owner";
    await renderPage();
    fireEvent.click(group("Density").getByRole("button", { name: "Compact" }));
    fireEvent.change(screen.getByLabelText("Or your own colour"), {
      target: { value: "#0d9488" },
    });
    expect(saveButton()).toBeDisabled();
  });

  it("shows the brand read-only, and resets only the display, for everyone else", async () => {
    await renderPage();
    expect(screen.getByText("Only an owner can change this")).toBeInTheDocument();
    expect(screen.getByText(/defaults for your display\./)).toBeInTheDocument();
  });

  it("previews real components", async () => {
    await renderPage();
    const preview = within(screen.getByRole("complementary", { name: "Preview" }));
    // Hidden from assistive tech: a picture of the page, not controls.
    expect(screen.getByText("Approve order").closest("[aria-hidden='true']")).not.toBeNull();
    expect(preview.getByRole("navigation", { name: "Sample navigation", hidden: true })).toBeInTheDocument();
    expect(preview.getByRole("button", { name: "Approve order", hidden: true })).toBeInTheDocument();
    expect(preview.getByText("3 days late")).toBeInTheDocument();
    expect(preview.getByRole("link", { name: "last 30 days", hidden: true })).toBeInTheDocument();
    expect(preview.getByRole("img", { name: "Sample bar chart", hidden: true })).toBeInTheDocument();
    expect(preview.getByRole("checkbox", { name: "Show counters no longer in use", hidden: true })).toBeChecked();
    // A picture, not controls: nothing in it is in the tab order.
    expect(preview.getByRole("button", { name: "Approve order", hidden: true })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });
});
