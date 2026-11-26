import { act, render } from "@testing-library/react";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { WidgetDef } from "../widgets/types";
import { DashboardCanvas } from "./dashboard-canvas";

/**
 * UI1 #205: canvas cards are as tall as their content. Each card's frame reports its height and
 * the canvas gives it just the rows that hold it, so a short card no longer stands empty in a
 * tall cell and a long one no longer scrolls inside a short one.
 */

type Observed = { el: Element; fire: () => void };
const observed: Observed[] = [];
const natural = new Map<string, number>();

beforeAll(() => {
  class FakeResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(el: Element) {
      observed.push({ el, fire: () => this.cb([], this as unknown as ResizeObserver) });
    }
    disconnect() {}
    unobserve() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  // The frame's height is whatever the test says its content is.
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const key = this.parentElement?.getAttribute("data-widget-key") ?? "";
    const height = natural.get(key) ?? 0;
    return {
      height,
      width: 600,
      top: 0,
      left: 0,
      right: 600,
      bottom: height,
      x: 0,
      y: 0,
    } as DOMRect;
  });
});

const short: WidgetDef = {
  key: "owner.short",
  title: "Short",
  width: "narrow",
  rows: 20,
  component: () => <div>three lines</div>,
} as unknown as WidgetDef;
const long: WidgetDef = {
  key: "owner.long",
  title: "Long",
  width: "narrow",
  rows: 8,
  component: () => <div>many lines</div>,
} as unknown as WidgetDef;

const data = {
  todaySales: [],
  failedSections: new Set(),
  reload: jest.fn(),
} as unknown as DashboardData;
const cellHeight = (container: HTMLElement, key: string) =>
  (container.querySelector(`[data-widget-key="${key}"]`) as HTMLElement).style.height;

function renderCanvas() {
  return render(
    <DashboardCanvas
      catalog={[short, long]}
      layout={[
        { key: "owner.short", x: 0, y: 0 },
        { key: "owner.long", x: 4, y: 0 },
      ]}
      data={data}
      isEditing={false}
      onLayoutChange={jest.fn()}
      onRemoveWidget={jest.fn()}
    />,
  );
}

afterEach(() => {
  observed.length = 0;
  natural.clear();
});

it("sizes each card from its measured content instead of the registry's row count", () => {
  natural.set("owner.short", 120);
  natural.set("owner.long", 500);
  const { container } = renderCanvas();
  // 120px needs 6 rows (6 × 12 + 5 × 14 = 142px), not the registry's 20 (506px).
  expect(cellHeight(container, "owner.short")).toBe("142px");
  // 500px needs 20 rows (506px), not the registry's 8, which would have made it scroll.
  expect(cellHeight(container, "owner.long")).toBe("506px");
});

it("follows a card whose content grows after the first paint", () => {
  natural.set("owner.short", 120);
  natural.set("owner.long", 120);
  const { container } = renderCanvas();
  expect(cellHeight(container, "owner.short")).toBe("142px");
  natural.set("owner.short", 300);
  act(() => observed.forEach((o) => o.fire()));
  // 300px → 12 rows → 12 × 12 + 11 × 14 = 298px is too short, so 13 rows: 324px.
  expect(cellHeight(container, "owner.short")).toBe("324px");
});
