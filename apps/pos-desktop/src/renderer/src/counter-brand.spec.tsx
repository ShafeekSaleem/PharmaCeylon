/** @jest-environment jsdom */
import { afterEach, expect, it, jest } from "@jest/globals";
import { act, cleanup, render, screen } from "@testing-library/react";
import { applyCounterBrand, useCounterBrand } from "./counter-brand";

const css = ":root:root {\n  --ui-accent: #1d5fa8;\n}";

afterEach(() => {
  cleanup();
  delete (window as { pos?: unknown }).pos;
  document.getElementById("pos-brand")?.remove();
  delete document.documentElement.dataset.statusSet;
});

it("draws the accent and status colours, and removes them for the defaults", () => {
  applyCounterBrand({ css, statusSet: "colour-blind" });
  expect(document.getElementById("pos-brand")?.textContent).toBe(css);
  expect(document.documentElement.dataset.statusSet).toBe("colour-blind");
  applyCounterBrand({ css: null, statusSet: "standard" });
  expect(document.getElementById("pos-brand")).toBeNull();
  expect(document.documentElement.dataset.statusSet).toBeUndefined();
});

function Probe() {
  const { themeLocked } = useCounterBrand();
  return <span>{themeLocked ? "locked" : "free"}</span>;
}

it("reads the brand from main and reports a locked theme", async () => {
  (window as unknown as { pos: unknown }).pos = {
    getCounterBrand: jest.fn(async () => ({ css, statusSet: "standard" })),
    getCounterTheme: jest.fn(async () => ({ theme: "light", locked: true })),
  };
  render(<Probe />);
  await act(async () => {});
  expect(screen.getByText("locked")).toBeTruthy();
  expect(document.getElementById("pos-brand")?.textContent).toBe(css);
});

it("draws nothing extra without the bridge (screenshot fixture, tests)", async () => {
  render(<Probe />);
  await act(async () => {});
  expect(screen.getByText("free")).toBeTruthy();
  expect(document.getElementById("pos-brand")).toBeNull();
});
