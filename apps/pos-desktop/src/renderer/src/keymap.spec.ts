/** @jest-environment jsdom */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { KeyMap, SCAN_GAP_MS, type Scope } from "./keymap";

let clock = 0;
let map: KeyMap;

/** A key press at `gap` ms after the last one (a person's pace unless told otherwise). */
function press(
  key: string,
  init: KeyboardEventInit & { target?: Element; gap?: number } = {},
) {
  const { target = document.body, gap = 200, ...rest } = init;
  clock += gap;
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...rest,
  });
  target.dispatchEvent(event);
  return event;
}

function scope(parent: Scope, { active = true, layer = false } = {}) {
  const s = map.createScope(parent, layer);
  map.setScope(s, true, active);
  return s;
}

function bind(
  s: Scope,
  keys: string | string[],
  handler = jest.fn<() => boolean | void>(),
  options = {},
) {
  map.bind(
    s,
    keys,
    () => handler,
    () => options,
  );
  return handler;
}

let detach: () => void;
beforeEach(() => {
  detach?.();
  document.body.innerHTML = "";
  clock = 0;
  map = new KeyMap(() => clock);
  detach = map.attach(window);
});

describe("scopes", () => {
  it("never fires a key on a hidden page", () => {
    const sell = scope(map.root, { active: true });
    const work = scope(map.root, { active: false });
    const onSell = bind(sell, "F8");
    const onWork = bind(work, "F8");
    press("F8");
    expect(onSell).toHaveBeenCalledTimes(1);
    expect(onWork).not.toHaveBeenCalled();

    map.setScope(sell, true, false);
    map.setScope(work, true, true);
    press("F8");
    expect(onSell).toHaveBeenCalledTimes(1);
    expect(onWork).toHaveBeenCalledTimes(1);
  });

  it("silences a page inside an inactive scope (the locked frame)", () => {
    const frame = scope(map.root, { active: false });
    const page = scope(frame);
    const onKey = bind(page, "F6");
    press("F6");
    expect(onKey).not.toHaveBeenCalled();
  });

  it("forgets a scope once it unmounts", () => {
    const page = scope(map.root);
    const onKey = bind(page, "F6");
    map.setScope(page, false, false);
    press("F6");
    expect(onKey).not.toHaveBeenCalled();
  });

  it("gives an open layer the keys, and the page none of them", () => {
    const page = scope(map.root);
    const onPageF8 = bind(page, "F8");
    const panel = scope(map.root, { layer: true });
    press("F8");
    expect(onPageF8).not.toHaveBeenCalled();
    const onPanel = bind(panel, "F8");
    press("F8");
    expect(onPanel).toHaveBeenCalledTimes(1);
    expect(onPageF8).not.toHaveBeenCalled();

    map.setScope(panel, false, false);
    press("F8");
    expect(onPageF8).toHaveBeenCalledTimes(1);
  });

  it("gives the keys to the innermost layer, then the newest", () => {
    const sheet = map.createScope(map.root, true);
    const dialog = map.createScope(sheet, true);
    // React mounts children first, so the inner layer can be "opened" before its parent.
    map.setScope(dialog, true, true);
    map.setScope(sheet, true, true);
    const onSheet = bind(sheet, "Escape");
    const onDialog = bind(dialog, "Escape");
    press("Escape");
    expect(onDialog).toHaveBeenCalledTimes(1);
    expect(onSheet).not.toHaveBeenCalled();

    const other = scope(map.root, { layer: true });
    const onOther = bind(other, "Escape");
    press("Escape");
    expect(onOther).toHaveBeenCalledTimes(1);
    expect(onDialog).toHaveBeenCalledTimes(1);
  });

  it("asks the deepest scope first, and the latest binding within a scope", () => {
    const page = scope(map.root);
    const part = scope(page);
    const calls: string[] = [];
    bind(
      page,
      "Ctrl+Enter",
      jest.fn(() => void calls.push("page")),
    );
    bind(
      part,
      "Ctrl+Enter",
      jest.fn(() => void calls.push("part")),
    );
    press("Enter", { ctrlKey: true });
    expect(calls).toEqual(["part"]);

    bind(
      part,
      "Ctrl+Enter",
      jest.fn(() => void calls.push("later")),
    );
    press("Enter", { ctrlKey: true });
    expect(calls).toEqual(["part", "later"]);
  });

  it("passes a key on when the handler returns false, and skips disabled bindings", () => {
    const onPage = bind(map.root, "Escape");
    const page = scope(map.root);
    const passes = bind(
      page,
      "Escape",
      jest.fn(() => false),
    );
    const disabled = bind(page, "Escape", jest.fn(), { enabled: false });
    const event = press("Escape");
    expect(passes).toHaveBeenCalled();
    expect(disabled).not.toHaveBeenCalled();
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("Esc order", () => {
  it("closes the topmost panel first, then goes back", () => {
    const page = scope(map.root);
    const back = bind(page, "Escape");
    const panel = scope(map.root, { layer: true });
    const close = bind(
      panel,
      "Escape",
      jest.fn(() => map.setScope(panel, false, false)),
    );
    press("Escape");
    expect(close).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    press("Escape");
    expect(back).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("focus rules", () => {
  function field(html = "<input />") {
    document.body.innerHTML = html;
    const element = document.body.firstElementChild as HTMLElement;
    element.focus();
    return element;
  }

  it("fires F-keys, Esc and Ctrl+Enter from inside a field", () => {
    const input = field();
    const f6 = bind(map.root, "F6");
    const esc = bind(map.root, "Escape");
    const main = bind(map.root, "Ctrl+Enter");
    press("F6", { target: input });
    press("Escape", { target: input });
    press("Enter", { target: input, ctrlKey: true });
    expect(f6).toHaveBeenCalled();
    expect(esc).toHaveBeenCalled();
    expect(main).toHaveBeenCalled();
  });

  it.each([
    "<input />",
    "<textarea></textarea>",
    "<select></select>",
    "<div contenteditable='true'></div>",
  ])("leaves number keys, Enter and Backspace to a focused %s", (html) => {
    const element = field(html);
    const digit = bind(map.root, "Digit");
    const enter = bind(map.root, "Enter");
    const back = bind(map.root, "Backspace");
    const typed = press("5", { target: element });
    press("Enter", { target: element });
    press("Backspace", { target: element });
    expect(digit).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(typed.defaultPrevented).toBe(false);
  });

  it("sends number keys to their binding when no field has focus", () => {
    const cash = jest.fn((event: KeyboardEvent) => void event.key);
    map.bind(map.root, "Digit", () => cash);
    const event = press("7");
    expect(cash).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    press("a");
    expect(cash).toHaveBeenCalledTimes(1);
  });

  it("lets a binding opt into or out of fields", () => {
    const input = field();
    const digit = bind(map.root, "Digit", jest.fn(), { inFields: true });
    const f7 = bind(map.root, "F7", jest.fn(), { inFields: false });
    press("1", { target: input });
    press("F7", { target: input });
    expect(digit).toHaveBeenCalled();
    expect(f7).not.toHaveBeenCalled();
  });

  it("matches modifiers exactly", () => {
    const f10 = bind(map.root, "F10");
    const enter = bind(map.root, "Enter");
    press("F10", { shiftKey: true }); // Shift+F10 is Windows' context-menu key
    press("Enter", { ctrlKey: true });
    press("Enter", { altKey: true });
    expect(f10).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    press("Enter", { shiftKey: true });
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("ignores a held key unless the binding asks for repeats", () => {
    const complete = bind(map.root, "F12");
    const digit = bind(map.root, "Digit", jest.fn(), { repeat: true });
    press("F12");
    press("F12", { repeat: true });
    press("1");
    press("1", { repeat: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(digit).toHaveBeenCalledTimes(2);
  });

  it("leaves a key alone that a field's own handler already took", () => {
    const enter = bind(map.root, "Ctrl+Enter");
    document.body.innerHTML = "<input />";
    const input = document.body.firstElementChild as HTMLElement;
    input.addEventListener("keydown", (event) => event.preventDefault());
    press("Enter", { target: input, ctrlKey: true });
    expect(enter).not.toHaveBeenCalled();
  });
});

describe("the barcode scanner", () => {
  /** A scan: the code's characters a few ms apart, then Enter. */
  function scan(code: string, target?: Element) {
    return [...code, "Enter"].map((key, i) =>
      press(key, { target, gap: i === 0 ? 500 : 5 }),
    );
  }

  it("never swallows a scan into the focused field", () => {
    document.body.innerHTML = "<input />";
    const input = document.body.firstElementChild as HTMLElement;
    input.focus();
    const digit = bind(map.root, "Digit");
    const enter = bind(map.root, "Enter");
    const events = scan("4791234567890", input);
    expect(digit).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    expect(events.some((event) => event.defaultPrevented)).toBe(false);
  });

  it("lets a scan through even with no field focused, after its first character", () => {
    const digit = bind(map.root, "Digit");
    const enter = bind(map.root, "Enter");
    const events = scan("4791234567890");
    // The first character can't be told from a key press; the rest of the burst and its Enter pass.
    expect(digit).toHaveBeenCalledTimes(1);
    expect(enter).not.toHaveBeenCalled();
    expect(events.slice(1).some((event) => event.defaultPrevented)).toBe(false);
  });

  it("still fires the map's own keys in the middle of a scan", () => {
    const f12 = bind(map.root, "F12");
    press("1", { gap: 500 });
    press("2", { gap: 5 });
    press("F12", { gap: 5 });
    expect(f12).toHaveBeenCalledTimes(1);
  });

  it("treats a person's typing as typing", () => {
    const digit = bind(map.root, "Digit");
    const enter = bind(map.root, "Enter");
    for (const key of ["1", "2", "3", "4"])
      press(key, { gap: SCAN_GAP_MS + 40 });
    press("Enter", { gap: 150 });
    expect(digit).toHaveBeenCalledTimes(4);
    expect(enter).toHaveBeenCalledTimes(1);
  });
});

describe("reserved keys", () => {
  it.each(["F5", "F6", "F7", "F8", "F9", "F10", "F12"])(
    "keeps %s from Chromium and Windows even when nothing is bound",
    (key) => {
      expect(press(key).defaultPrevented).toBe(true);
    },
  );

  it("leaves F11 and ordinary keys alone", () => {
    expect(press("F11").defaultPrevented).toBe(false);
    expect(press("a").defaultPrevented).toBe(false);
    expect(press("Enter").defaultPrevented).toBe(false);
  });

  it("does nothing on F9 yet: discounts are phase 2", () => {
    const event = press("F9");
    expect(event.defaultPrevented).toBe(true);
  });
});
