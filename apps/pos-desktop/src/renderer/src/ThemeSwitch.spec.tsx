/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, it, jest } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeSwitch } from "./ThemeSwitch";

let systemDark = false;

beforeEach(() => {
  systemDark = false;
  delete document.documentElement.dataset.theme;
  window.matchMedia = ((query: string) => ({
    matches: systemDark && query.includes("dark"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
});

afterEach(() => {
  cleanup();
  delete (window as { pos?: unknown }).pos;
});

function withBridge() {
  const setCounterTheme = jest.fn(
    async ({ theme }: { theme: string }) => ({ theme, locked: false }),
  );
  (window as unknown as { pos: unknown }).pos = { setCounterTheme };
  return setCounterTheme;
}

it("offers dark on a light counter and asks main to remember it", () => {
  const set = withBridge();
  render(<ThemeSwitch />);
  fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
  expect(set).toHaveBeenCalledWith({ theme: "dark" });
  expect(
    screen.getByRole("button", { name: "Switch to light theme" }),
  ).toBeTruthy();
});

it("offers light when Windows is dark", () => {
  systemDark = true;
  const set = withBridge();
  render(<ThemeSwitch />);
  fireEvent.click(
    screen.getByRole("button", { name: "Switch to light theme" }),
  );
  expect(set).toHaveBeenCalledWith({ theme: "light" });
});

it("still renders without a bridge (screenshot fixture)", () => {
  document.documentElement.dataset.theme = "dark";
  render(<ThemeSwitch />);
  expect(
    screen.getByRole("button", { name: "Switch to light theme" }),
  ).toBeTruthy();
});
