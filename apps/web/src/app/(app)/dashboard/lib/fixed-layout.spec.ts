import { FIXED_WIDGET_KEYS, isFixedWidget } from "./fixed-layout";
import { DEFAULT_LAYOUTS } from "../widgets/default-layouts";

it("keeps customise defaults below the fixed owner/manager widgets", () => {
  for (const role of ["owner", "manager"] as const) {
    const fixed = new Set(FIXED_WIDGET_KEYS[role]);
    for (const widget of DEFAULT_LAYOUTS[role]) {
      expect(fixed.has(widget.key)).toBe(false);
    }
  }
});

it("marks owner payment mix as fixed-only", () => {
  expect(isFixedWidget("owner", "owner.payment-mix")).toBe(true);
  expect(isFixedWidget("owner", "owner.cash-flow")).toBe(false);
});