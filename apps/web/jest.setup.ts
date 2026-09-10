import "@testing-library/jest-dom";

/**
 * jsdom implements neither of these, and both are used by shared components the products
 * screens render (FloatingTooltipHost measures, DataTable observes its scroll container). An
 * unimplemented API throws rather than no-ops, which fails tests for reasons that have nothing
 * to do with what they assert.
 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as never;

/* Middleware and other server-side modules run under the `node` environment,
   where there is no `window` or `Element` to patch. Everything below is
   jsdom-only, so guard it rather than forcing those specs back onto jsdom —
   `next/server` needs the Fetch globals that jsdom does not provide. */
const isDom = typeof window !== "undefined";

if (isDom && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
}

// jsdom has no layout, so anything that scrolls an element into view would throw.
if (isDom) {
  Element.prototype.scrollIntoView ??= () => {};
}
