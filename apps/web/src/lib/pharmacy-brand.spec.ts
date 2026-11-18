import {
  DEFAULT_PHARMACY_APPEARANCE,
  type PharmacyAppearance,
} from "@pharmaceylon/shared";
import {
  BRAND_BOOTSTRAP_SCRIPT,
  BRAND_CHANGED_EVENT,
  adoptPharmacyBrand,
  applyPharmacyBrand,
  brandCss,
  clearAppliedBrand,
  readCachedBrand,
} from "./pharmacy-brand";

const root = document.documentElement;
const styleEl = () => document.getElementById("pc-brand");

function reset() {
  styleEl()?.remove();
  delete root.dataset.statusSet;
  delete root.dataset.sidebar;
  delete root.dataset.chart;
  window.localStorage.clear();
}

/** Signs a user of `tenantId` into this browser's stored session, as the auth client does. */
function signIn(tenantId = "tenant-a") {
  window.localStorage.setItem(
    "pharmaceylon_user_json",
    JSON.stringify({ id: `user-${tenantId}`, tenantId }),
  );
}

beforeEach(() => {
  reset();
  signIn();
});

const ocean = { ...DEFAULT_PHARMACY_APPEARANCE, accent: "#1d5fa8" };

describe("applyPharmacyBrand", () => {
  it("adds no stylesheet for the default teal, which tokens.css already draws", () => {
    expect(brandCss(DEFAULT_PHARMACY_APPEARANCE)).toBeNull();
    applyPharmacyBrand(DEFAULT_PHARMACY_APPEARANCE);
    expect(styleEl()).toBeNull();
  });

  it("writes a custom accent as one stylesheet and removes it on return to the default", () => {
    applyPharmacyBrand(ocean);
    expect(styleEl()?.textContent).toContain("--ui-accent: #1d5fa8;");
    applyPharmacyBrand(ocean);
    expect(document.querySelectorAll("#pc-brand")).toHaveLength(1);
    applyPharmacyBrand(DEFAULT_PHARMACY_APPEARANCE);
    expect(styleEl()).toBeNull();
  });

  it("switches the chart series with data-chart", () => {
    applyPharmacyBrand({ ...ocean, chartPalette: "distinct" });
    expect(root.dataset.chart).toBe("distinct");
    applyPharmacyBrand(ocean);
    expect(root.dataset.chart).toBeUndefined();
  });

  it("sets the status colour set and sidebar style as attributes", () => {
    applyPharmacyBrand({
      ...ocean,
      statusSet: "colour-blind",
      sidebarStyle: "dark",
    });
    expect(root.dataset.statusSet).toBe("colour-blind");
    expect(root.dataset.sidebar).toBe("dark");
    applyPharmacyBrand(DEFAULT_PHARMACY_APPEARANCE);
    expect(root.dataset.statusSet).toBeUndefined();
    expect(root.dataset.sidebar).toBeUndefined();
  });
});

describe("adoptPharmacyBrand", () => {
  it("applies, caches and announces what the server confirmed", () => {
    const brand: PharmacyAppearance = {
      ...ocean,
      version: 2,
      updatedAt: "2026-11-19T08:00:00Z",
    };
    const heard = jest.fn();
    window.addEventListener(BRAND_CHANGED_EVENT, heard);
    adoptPharmacyBrand(brand);
    window.removeEventListener(BRAND_CHANGED_EVENT, heard);
    expect(styleEl()).not.toBeNull();
    expect(readCachedBrand()).toEqual(ocean);
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toBe(brand);
  });
});

describe("BRAND_BOOTSTRAP_SCRIPT", () => {
  const run = () => new Function(BRAND_BOOTSTRAP_SCRIPT)();

  it("redraws the cached brand before React loads", () => {
    adoptPharmacyBrand({
      ...ocean,
      sidebarStyle: "tinted",
      statusSet: "colour-blind",
      version: 1,
      updatedAt: null,
    });
    reset();
    signIn();
    window.localStorage.setItem(
      "pc_brand",
      JSON.stringify({
        tenantId: "tenant-a",
        settings: {
          ...ocean,
          sidebarStyle: "tinted",
          statusSet: "colour-blind",
        },
        css: brandCss(ocean),
      }),
    );
    run();
    expect(styleEl()?.textContent).toContain("#1d5fa8");
    expect(root.dataset.sidebar).toBe("tinted");
    expect(root.dataset.statusSet).toBe("colour-blind");
  });

  it("never throws on malformed or absent storage", () => {
    expect(run).not.toThrow();
    window.localStorage.setItem("pc_brand", "{not json");
    expect(run).not.toThrow();
    window.localStorage.setItem(
      "pc_brand",
      JSON.stringify({ settings: { sidebarStyle: "neon" } }),
    );
    run();
    expect(root.dataset.sidebar).toBeUndefined();
  });
});

describe("the brand cache belongs to one pharmacy", () => {
  const cacheOcean = () =>
    adoptPharmacyBrand({ ...ocean, version: 1, updatedAt: null });

  it("isn't read for another pharmacy's user", () => {
    cacheOcean();
    expect(readCachedBrand()).toEqual(ocean);
    signIn("tenant-b");
    expect(readCachedBrand()).toBeNull();
  });

  it("isn't drawn before first paint for another pharmacy, or with nobody signed in", () => {
    cacheOcean();
    const run = () => new Function(BRAND_BOOTSTRAP_SCRIPT)();
    styleEl()?.remove();
    signIn("tenant-b");
    run();
    expect(styleEl()).toBeNull();
    window.localStorage.removeItem("pharmaceylon_user_json");
    run();
    expect(styleEl()).toBeNull();
    signIn("tenant-a");
    run();
    expect(styleEl()?.textContent).toContain("#1d5fa8");
  });

  it("isn't written with nobody signed in", () => {
    window.localStorage.removeItem("pharmaceylon_user_json");
    cacheOcean();
    expect(window.localStorage.getItem("pc_brand")).toBeNull();
  });

  it("goes back to the defaults on the page after signing out", () => {
    cacheOcean();
    root.dataset.sidebar = "dark";
    clearAppliedBrand();
    expect(styleEl()).toBeNull();
    expect(root.dataset.sidebar).toBeUndefined();
  });
});
