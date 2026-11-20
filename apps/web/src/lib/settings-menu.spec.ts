import {
  SETTINGS_GROUPS,
  SETTINGS_ITEMS,
  groupSettingsItems,
  searchSettings,
  settingsGroupScope,
  settingsItemFor,
  visibleSettingsItems,
} from "./settings-menu";

const ALL = visibleSettingsItems({ isAdmin: true, personalOnly: false });

describe("settings menu (UI1 #205)", () => {
  it("gives every item its own icon and a known group", () => {
    const groups = new Set(SETTINGS_GROUPS.map((g) => g.key));
    for (const item of SETTINGS_ITEMS) expect(groups.has(item.group)).toBe(true);
    // Each item names a different icon component.
    const icons = SETTINGS_ITEMS.map((item) => {
      const el = item.icon(16) as { type: { name: string } };
      return el.type.name;
    });
    expect(new Set(icons).size).toBe(SETTINGS_ITEMS.length);
  });

  it("states the scope once per group", () => {
    // Password & Login and Appearance hold owner settings too, so "You" does not say "only".
    const you = SETTINGS_GROUPS.find((g) => g.key === "you");
    expect(you && settingsGroupScope(you)).toBe(
      "Your account (owner settings for everyone are marked on the page)",
    );
    for (const g of SETTINGS_GROUPS.filter((g) => g.key !== "you"))
      expect(g.scope).toBe("Everyone");
  });

  it("shows admin pages only with tenant management, and only personal pages when restricted", () => {
    const self = visibleSettingsItems({ isAdmin: false, personalOnly: false });
    expect(self.every((item) => !item.adminOnly)).toBe(true);
    expect(groupSettingsItems(self).map((g) => g.group.key)).toEqual(["you"]);

    const restricted = visibleSettingsItems({
      isAdmin: true,
      personalOnly: true,
    });
    expect(restricted.map((i) => i.href)).toEqual([
      "/settings/my-profile",
      "/settings/password-login",
      "/settings/appearance",
    ]);
  });

  it("finds a page by name and by a field inside it", () => {
    expect(searchSettings(ALL, "refund limit").map((m) => m.item.label)).toEqual([
      "Approval Rules",
    ]);
    expect(searchSettings(ALL, "refund limit")[0]?.field).toBe("refund limit");
    expect(searchSettings(ALL, "branches")[0]?.item.label).toBe("Branches");
    expect(searchSettings(ALL, "VAT").map((m) => m.item.label)).toContain("Catalog");
    expect(searchSettings(ALL, "accent colour")[0]?.item.label).toBe("Appearance");
    expect(searchSettings(ALL, "accent color")[0]?.item.label).toBe("Appearance");
  });

  it("puts name matches before field matches and needs every word", () => {
    const results = searchSettings(ALL, "counter");
    expect(results[0]?.field).toBeUndefined();
    expect(searchSettings(ALL, "refund banana")).toEqual([]);
    expect(searchSettings(ALL, "   ")).toEqual([]);
  });

  it("does not find pages you cannot open", () => {
    const self = visibleSettingsItems({ isAdmin: false, personalOnly: false });
    expect(searchSettings(self, "refund limit")).toEqual([]);
  });

  it("maps a sub-page to its parent item", () => {
    expect(settingsItemFor("/settings/branches/hours")?.label).toBe("Branches");
    expect(settingsItemFor("/settings")).toBeUndefined();
    // Profitability folded into Catalog and redirects there.
    expect(settingsItemFor("/settings/profitability")?.label).toBe("Catalog");
    expect(settingsItemFor("/settings/alerts-recipients")?.label).toBe("Recipients & Channels");
    expect(settingsItemFor("/settings/insights-reports")?.label).toBe("Insights & Reports");
  });

  it("splits the counter pages into Counters, Receipts, Payments and Offline selling", () => {
    const counter = SETTINGS_ITEMS.filter((item) => item.group === "counter");
    expect(counter.map((item) => [item.label, item.href])).toEqual([
      ["Counters", "/settings/counters"],
      ["Receipts", "/settings/receipts"],
      ["Payments", "/settings/payments"],
      ["Offline selling", "/settings/offline-selling"],
    ]);
    // The old routes redirect, and the menu marks the page they land on.
    expect(settingsItemFor("/settings/main")?.label).toBe("Counters");
    expect(settingsItemFor("/settings/offline-policy")?.label).toBe("Offline selling");
    // Search finds each setting where it lives now.
    expect(searchSettings(ALL, "receipt prefix")[0]?.item.label).toBe("Receipts");
    expect(searchSettings(ALL, "auto-print")[0]?.item.label).toBe("Receipts");
    expect(searchSettings(ALL, "default payment method")[0]?.item.label).toBe("Payments");
    expect(searchSettings(ALL, "max discount")[0]?.item.label).toBe("Counters");
    expect(searchSettings(ALL, "journal recovery")[0]?.item.label).toBe("Offline selling");
    expect(SETTINGS_ITEMS.some((item) => /Counters &/.test(item.label))).toBe(false);
  });
});
