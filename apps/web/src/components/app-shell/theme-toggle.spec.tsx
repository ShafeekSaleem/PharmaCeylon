import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  readAppearancePrefs,
  saveAppearancePrefs,
  DEFAULT_APPEARANCE_PREFS,
} from "@/lib/appearance";
import { ThemeToggle } from "./theme-toggle";

jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

function mockSystemDark(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: dark && query.includes("dark"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  mockSystemDark(false);
});

it("offers dark on a light page and saves it as the person's choice", () => {
  render(<ThemeToggle />);
  fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));

  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(readAppearancePrefs("u1").theme).toBe("dark");
  expect(
    screen.getByRole("button", { name: "Switch to light theme" }),
  ).toBeInTheDocument();
});

it("flips what a dark device shows when the person follows the device", () => {
  mockSystemDark(true);
  render(<ThemeToggle />);
  fireEvent.click(
    screen.getByRole("button", { name: "Switch to light theme" }),
  );

  expect(document.documentElement.dataset.theme).toBe("light");
  expect(readAppearancePrefs("u1").theme).toBe("light");
});

it("follows a change made on the Appearance page", () => {
  render(<ThemeToggle />);
  act(() =>
    saveAppearancePrefs({ ...DEFAULT_APPEARANCE_PREFS, theme: "dark" }, "u1"),
  );
  expect(
    screen.getByRole("button", { name: "Switch to light theme" }),
  ).toBeInTheDocument();
});

it("keeps the other preferences when switching", () => {
  saveAppearancePrefs(
    { ...DEFAULT_APPEARANCE_PREFS, density: "compact", accent: "navy" },
    "u1",
  );
  render(<ThemeToggle />);
  fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
  expect(readAppearancePrefs("u1")).toMatchObject({
    theme: "dark",
    density: "compact",
    accent: "navy",
  });
});
