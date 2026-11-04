import { blockedInPackagedBuild, COUNTER_KEYS, type KeyInput } from "./keyboard";

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  type: "keyDown",
  key: k,
  control: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods,
});

describe("blockedInPackagedBuild", () => {
  it.each(["F6", "F7", "F8", "F9", "F10", "F12", "Escape", "Enter", "5"])(
    "never blocks the counter's key %s, so the renderer still receives it",
    (k) => {
      expect(blockedInPackagedBuild(key(k))).toBe(false);
      expect(blockedInPackagedBuild(key(k, { shift: true }))).toBe(false);
    },
  );

  it("never blocks Ctrl+Enter", () => {
    expect(blockedInPackagedBuild(key("Enter", { control: true }))).toBe(false);
  });

  it.each([
    ["F5", {}],
    ["r", { control: true }],
    ["R", { control: true, shift: true }],
    ["I", { control: true, shift: true }],
    ["J", { control: true, shift: true }],
    ["C", { control: true, shift: true }],
  ] as const)("blocks reload and developer tools: %s", (k, mods) => {
    expect(blockedInPackagedBuild(key(k, mods))).toBe(true);
  });

  it("leaves typing and key-up events alone", () => {
    expect(blockedInPackagedBuild(key("r"))).toBe(false);
    expect(blockedInPackagedBuild(key("c", { control: true }))).toBe(false);
    expect(blockedInPackagedBuild(key("F5", { type: "keyUp" }))).toBe(false);
  });

  it("lists every F-key the renderer's map reserves", () => {
    for (const k of ["F6", "F7", "F8", "F9", "F10", "F12"]) expect(COUNTER_KEYS.has(k)).toBe(true);
  });
});
