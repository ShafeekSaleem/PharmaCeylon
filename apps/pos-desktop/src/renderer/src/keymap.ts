/**
 * The counter's one keyboard map.
 *
 * A single `keydown` listener on the window hands each key to the bindings that are live right
 * now. Nothing else in the renderer listens to `keydown` on the window, so two screens can never
 * both act on one key press.
 *
 * ## Scopes
 *
 * Every binding belongs to a scope, the nearest `<KeyScope>` above it (or the root, if none).
 *
 * - `<KeyScope active={page === "sell"}>` wraps a page. `Shell` keeps pages mounted while hidden,
 *   so a hidden page's scope is inactive and its keys never fire. A scope is live only while it
 *   and every scope above it are active.
 * - `<KeyScope layer>` wraps a sheet, panel or dialog. While a layer is live, only the topmost
 *   layer's bindings (and those of scopes inside it) can fire: the page underneath goes quiet.
 *   The topmost layer is the innermost one, and among siblings the one opened last.
 *
 * Within the live set, the deepest scope is asked first, and in one scope the binding registered
 * last. A handler that returns `false` passes the key on to the next binding; any other return
 * means it was handled, and the key's default action is prevented.
 *
 * So **Esc** closes the topmost layer when one is open (it bound Esc), and otherwise reaches the
 * page, whose Esc goes back.
 *
 * ## Keys
 *
 * `"F6"`, `"Escape"` (or `"Esc"`), `"Enter"`, `"Ctrl+Enter"`, `"Backspace"`, and `"Digit"` for any
 * of 0–9 (the handler reads `event.key`). Ctrl, Alt and Shift must match the spec exactly for
 * F-keys; for other keys Shift is ignored, since it is part of typing.
 *
 * ## Focus rules
 *
 * - F-keys, Esc and anything with Ctrl or Alt fire even while focus is in a field: they are the
 *   map's own keys and type nothing.
 * - Everything else (digits, Enter, Backspace) is skipped while focus is in an input, textarea,
 *   select or editable element, so number keys reach the cash field only when no field has focus
 *   and typing into a field is never taken over. Override with `{ inFields: true | false }`.
 * - Key repeat (a held key) fires only bindings that ask for `{ repeat: true }`, so holding F12
 *   cannot complete two sales.
 *
 * ## The barcode scanner
 *
 * The scanner types like a keyboard, very fast, and ends with Enter. Printable keys that arrive
 * less than {@link SCAN_GAP_MS} apart are a scan: for the rest of the burst, including the Enter
 * that ends it, no unmodified binding fires and nothing is prevented, so the scan lands in the
 * focused field exactly as typed. The first character of a burst can't be told from a person's
 * key press; screens that may receive a scan with no field focused (Sell) move focus to their
 * search field. A key some field already handled (`preventDefault` in its own `onKeyDown`) is
 * left alone too.
 *
 * ## Reserved keys
 *
 * F5–F10 and F12 always have their default prevented, bound or not, so Chromium and Windows never
 * act on them (F10 would put Windows into menu mode, F5 reads as "reload"). F9 is reserved for
 * discounts and does nothing yet.
 *
 * ## API
 *
 * ```tsx
 * useKeyBinding("F8", hold, { enabled: canHold });
 * useKeyBinding("Ctrl+Enter", () => formRef.current && clickSubmit(formRef.current));
 * <KeyScope active={page === "work"}>…</KeyScope>
 * <KeyScope layer>…the sheet…</KeyScope>
 * <KeyBinding keys="Escape" onKey={goBack} />   // the hook as a component, for placing in a scope
 * ```
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Return `false` to pass the key on; anything else means handled. */
export type KeyHandler = (event: KeyboardEvent) => boolean | void;

export type KeyBindingOptions = {
  /** Off: the binding stays registered but never fires. Default true. */
  enabled?: boolean;
  /** Whether it fires while focus is in a field. Default: true for F-keys, Esc and Ctrl/Alt keys. */
  inFields?: boolean;
  /** Whether a held key's repeats fire it. Default false. */
  repeat?: boolean;
};

/** Printable keys closer together than this are the scanner, not a person. */
export const SCAN_GAP_MS = 30;

/** Never left to Chromium or Windows. F11 stays free for full screen in development. */
const RESERVED = new Set(["F5", "F6", "F7", "F8", "F9", "F10", "F12"]);

type Combo = {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  fn: boolean;
};

export function parseKey(spec: string): Combo {
  const parts = spec.split("+").map((part) => part.trim());
  let key = parts.pop() ?? "";
  if (key === "Esc") key = "Escape";
  const mods = new Set(parts.map((part) => part.toLowerCase()));
  return {
    key,
    ctrl: mods.has("ctrl"),
    alt: mods.has("alt"),
    shift: mods.has("shift"),
    fn: /^F\d{1,2}$/.test(key),
  };
}

function matches(combo: Combo, event: KeyboardEvent) {
  if (combo.key === "Digit" ? !/^\d$/.test(event.key) : event.key !== combo.key)
    return false;
  if (
    event.ctrlKey !== combo.ctrl ||
    event.altKey !== combo.alt ||
    event.metaKey
  )
    return false;
  if ((combo.fn || combo.shift) && event.shiftKey !== combo.shift) return false;
  return true;
}

/** The map's own keys type nothing, so they work from inside a field. */
const firesInFields = (combo: Combo) =>
  combo.fn || combo.key === "Escape" || combo.ctrl || combo.alt;

export function inField(target: EventTarget | null): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(
    element.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ),
  );
}

export type Scope = {
  parent: Scope | null;
  /** False while its page is hidden, or a sheet is closed. */
  active: boolean;
  layer: boolean;
  /** Set while mounted; a removed scope is dead even if something still holds it. */
  mounted: boolean;
  openedAt: number;
};

type Binding = {
  scope: Scope;
  combos: Combo[];
  handler: () => KeyHandler;
  options: () => KeyBindingOptions;
  order: number;
};

export class KeyMap {
  readonly root: Scope = {
    parent: null,
    active: true,
    layer: false,
    mounted: true,
    openedAt: 0,
  };
  private bindings = new Set<Binding>();
  private layers = new Set<Scope>();
  private seq = 0;
  private lastPrintable = -Infinity;
  private scanning = false;

  /** `now` is injectable so tests can type at human or scanner speed. */
  constructor(private readonly now: () => number = () => performance.now()) {}

  createScope(parent: Scope, layer = false): Scope {
    return { parent, active: false, layer, mounted: false, openedAt: 0 };
  }

  /** Mounts or re-activates a scope. A layer that opens becomes the newest. */
  setScope(scope: Scope, mounted: boolean, active: boolean) {
    if (scope.layer && active && mounted && !(scope.active && scope.mounted))
      scope.openedAt = ++this.seq;
    scope.mounted = mounted;
    scope.active = active;
    if (scope.layer && mounted) this.layers.add(scope);
    else this.layers.delete(scope);
  }

  bind(
    scope: Scope,
    keys: string | readonly string[],
    handler: () => KeyHandler,
    options: () => KeyBindingOptions = () => ({}),
  ): () => void {
    const binding: Binding = {
      scope,
      combos: (typeof keys === "string" ? [keys] : keys).map(parseKey),
      handler,
      options,
      order: ++this.seq,
    };
    this.bindings.add(binding);
    return () => void this.bindings.delete(binding);
  }

  private live(scope: Scope) {
    for (let s: Scope | null = scope; s; s = s.parent)
      if (!s.active || !s.mounted) return false;
    return true;
  }

  private within(scope: Scope, ancestor: Scope) {
    for (let s: Scope | null = scope; s; s = s.parent)
      if (s === ancestor) return true;
    return false;
  }

  private depth(scope: Scope) {
    let depth = 0;
    for (let s = scope.parent; s; s = s.parent) depth++;
    return depth;
  }

  /** The innermost live layer; among siblings, the one opened last. */
  topLayer(): Scope | null {
    const layers = [...this.layers].filter((layer) => this.live(layer));
    let top: Scope | null = null;
    for (const layer of layers) {
      const hasInner = layers.some(
        (other) => other !== layer && this.within(other, layer),
      );
      if (!hasInner && (!top || layer.openedAt > top.openedAt)) top = layer;
    }
    return top;
  }

  /** Runs the key through the live bindings. True if one handled it. */
  dispatch(event: KeyboardEvent): boolean {
    const scan = this.trackScanner(event);
    if (event.defaultPrevented || event.isComposing) return false;
    const reserved = RESERVED.has(event.key);
    const fieldFocused = inField(event.target);
    const top = this.topLayer();

    const candidates = [...this.bindings]
      .filter((b) => this.live(b.scope) && (!top || this.within(b.scope, top)))
      .sort(
        (a, b) =>
          this.depth(b.scope) - this.depth(a.scope) || b.order - a.order,
      );

    for (const binding of candidates) {
      const combo = binding.combos.find((c) => matches(c, event));
      if (!combo) continue;
      const options = binding.options();
      if (options.enabled === false) continue;
      if (event.repeat && !options.repeat) continue;
      const modifierFree = !firesInFields(combo);
      if (fieldFocused && !(options.inFields ?? !modifierFree)) continue;
      // A scan types into whatever has focus; only the map's own keys interrupt it.
      if (scan && modifierFree) continue;
      if (binding.handler()(event) === false) continue;
      event.preventDefault();
      return true;
    }
    if (reserved) event.preventDefault();
    return false;
  }

  /** True while the key belongs to a scanner burst: fast printable keys and the Enter that ends them. */
  private trackScanner(event: KeyboardEvent): boolean {
    const printable =
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey;
    const now = this.now();
    if (printable) {
      this.scanning = now - this.lastPrintable < SCAN_GAP_MS;
      this.lastPrintable = now;
      return this.scanning;
    }
    if (event.key === "Enter" && !event.ctrlKey && !event.altKey) {
      const ends = this.scanning && now - this.lastPrintable < SCAN_GAP_MS * 3;
      this.scanning = false;
      this.lastPrintable = -Infinity;
      return ends;
    }
    if (event.key !== "Shift") {
      this.scanning = false;
      this.lastPrintable = -Infinity;
    }
    return false;
  }

  /** Listens on a window; returns the detach. */
  attach(target: Window): () => void {
    const listener = (event: KeyboardEvent) => void this.dispatch(event);
    target.addEventListener("keydown", listener);
    return () => target.removeEventListener("keydown", listener);
  }
}

/** The app's one map, attached to the window the first time anything binds a key. */
export const keyMap = new KeyMap();
let attached = false;

type Context = { map: KeyMap; scope: Scope };
const KeyContext = createContext<Context | null>(null);

function useKeyContext(): Context {
  const context = useContext(KeyContext);
  if (context) return context;
  if (!attached && typeof window !== "undefined") {
    keyMap.attach(window);
    attached = true;
  }
  return { map: keyMap, scope: keyMap.root };
}

/**
 * Uses its own map instead of the app's: for tests, which need a clock, and nothing else.
 * Attaches the map to the window while mounted.
 */
export function KeyMapProvider({
  map,
  children,
}: {
  map: KeyMap;
  children?: ReactNode;
}) {
  useEffect(() => map.attach(window), [map]);
  return createElement(
    KeyContext.Provider,
    { value: { map, scope: map.root } },
    children,
  );
}

/** A page (`active` while shown) or, with `layer`, a sheet, panel or dialog. See the file comment. */
export function KeyScope({
  active = true,
  layer = false,
  children,
}: {
  active?: boolean;
  layer?: boolean;
  children?: ReactNode;
}) {
  const parent = useKeyContext();
  const [context] = useState<Context>(() => ({
    map: parent.map,
    scope: parent.map.createScope(parent.scope, layer),
  }));
  const { map, scope } = context;
  // Layout effects, so the scope is in its new state before any key can arrive after the commit.
  useLayoutEffect(() => {
    map.setScope(scope, true, active);
  }, [map, scope, active]);
  useLayoutEffect(() => () => map.setScope(scope, false, false), [map, scope]);
  return createElement(KeyContext.Provider, { value: context }, children);
}

/**
 * Binds `keys` in the nearest scope for as long as the component is mounted. The handler and
 * options are read when the key arrives, so they can close over the latest state freely.
 */
export function useKeyBinding(
  keys: string | readonly string[],
  handler: KeyHandler,
  options: KeyBindingOptions = {},
) {
  const { map, scope } = useKeyContext();
  const latest = useRef({ handler, options });
  latest.current = { handler, options };
  const spec = typeof keys === "string" ? keys : keys.join(" ");
  useEffect(
    () =>
      map.bind(
        scope,
        spec.split(" "),
        () => latest.current.handler,
        () => latest.current.options,
      ),
    [map, scope, spec],
  );
}

/** `useKeyBinding` as a component, for binding inside a `<KeyScope>` from the component that renders it. */
export function KeyBinding({
  keys,
  onKey,
  ...options
}: KeyBindingOptions & {
  keys: string | readonly string[];
  onKey: KeyHandler;
}) {
  useKeyBinding(keys, onKey, options);
  return null;
}

/** Ctrl+Enter's usual job: press the form's submit button, if it can be pressed. */
export function clickSubmit(form: HTMLFormElement | null): boolean {
  const button = form?.querySelector<HTMLButtonElement>(
    "button[type='submit']",
  );
  if (!button || button.disabled) return false;
  button.click();
  return true;
}
