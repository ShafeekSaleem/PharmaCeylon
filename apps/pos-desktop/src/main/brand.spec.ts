import { describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PHARMACY_APPEARANCE } from "@pharmaceylon/shared";
import { createCounterBrand, readCachedBrand } from "./brand";

const fresh = () =>
  join(
    mkdtempSync(join(tmpdir(), "pos-brand-")),
    "nested",
    "counter-brand.json",
  );

const ocean = {
  ...DEFAULT_PHARMACY_APPEARANCE,
  accent: "#1d5fa8",
  statusSet: "colour-blind" as const,
  counterTheme: "dark" as const,
  counterThemeLocked: true,
};

function setup(
  path = fresh(),
  answer: () => Promise<unknown> = async () => ({
    ...ocean,
    version: 2,
    updatedAt: null,
  }),
  signedIn = true,
) {
  const request = jest.fn(answer);
  const onChange = jest.fn();
  const report = jest.fn();
  const brand = createCounterBrand({
    path,
    api: { request: request as never },
    signedIn: () => signedIn,
    onChange,
    report,
  });
  return { brand, request, onChange, report, path };
}

describe("counter brand", () => {
  it("draws the PharmaCeylon defaults before it has ever reached the server", () => {
    const { brand } = setup();
    expect(brand.view()).toEqual({ css: null, statusSet: "standard" });
    expect(brand.themePolicy()).toEqual({ theme: "system", locked: false });
    expect(brand.receiptAccent()).toBe("#0f766e");
  });

  it("reads the owner's brand after sign-in, keeps it, and says it changed", async () => {
    const { brand, request, onChange, path } = setup();
    await expect(brand.refresh()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("GET", "/tenant/appearance");
    expect(onChange).toHaveBeenCalledWith(ocean);
    expect(brand.view().css).toContain("--ui-accent: #1d5fa8;");
    expect(brand.view().statusSet).toBe("colour-blind");
    expect(brand.themePolicy()).toEqual({ theme: "dark", locked: true });
    expect(brand.receiptAccent()).toBe("#1d5fa8");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      settings: ocean,
      version: 2,
    });

    // Same answer again: nothing to redraw.
    await expect(brand.refresh()).resolves.toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("starts offline with the last brand this counter saw", async () => {
    const { brand, path } = setup();
    await brand.refresh();
    const restarted = setup(path, async () => {
      throw new Error("offline");
    });
    expect(restarted.brand.themePolicy()).toEqual({
      theme: "dark",
      locked: true,
    });
    await expect(restarted.brand.refresh()).resolves.toBe(false);
    expect(restarted.report).toHaveBeenCalled();
    expect(restarted.brand.view().statusSet).toBe("colour-blind");
  });

  it("does not ask while nobody is signed in", async () => {
    const { brand, request } = setup(undefined, undefined, false);
    await expect(brand.refresh()).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the cached brand when the server sends something it can't use", async () => {
    const path = fresh();
    await setup(path).brand.refresh();
    const { brand, report } = setup(path, async () => ({
      ...ocean,
      accent: "#22d3ee",
    }));
    await brand.refresh();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/Too light/) }),
    );
    expect(brand.receiptAccent()).toBe("#1d5fa8");
  });

  it("asks once when sign-in and the timer fire together", async () => {
    const { brand, request } = setup();
    await Promise.all([brand.refresh(), brand.refresh()]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("ignores a broken cache file", async () => {
    const path = fresh();
    await setup(path).brand.refresh();
    writeFileSync(path, "{nope");
    expect(readCachedBrand(path)).toBeNull();
  });
});
