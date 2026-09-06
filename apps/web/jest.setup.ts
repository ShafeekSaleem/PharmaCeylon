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

if (!window.matchMedia) {
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
Element.prototype.scrollIntoView ??= () => {};
