import { jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";
import {
  emptyEnrollmentOfflineBackup,
  type DeviceState,
} from "../../shared/ipc-contract";

export { emptyEnrollmentOfflineBackup };
import { KeyMap, KeyMapProvider } from "../src/keymap";

export const ids = {
  ana: "00000000-0000-4000-8000-000000000001",
  ben: "00000000-0000-4000-8000-000000000002",
  branch: "00000000-0000-4000-8000-0000000000b1",
  register: "00000000-0000-4000-8000-0000000000c1",
  till: "00000000-0000-4000-8000-0000000000d1",
  session: "00000000-0000-4000-8000-0000000000e1",
  register2: "00000000-0000-4000-8000-0000000000c2",
};

export function deviceState(overrides: Partial<DeviceState> = {}): DeviceState {
  const { enrollment: enrollmentOverride, ...rest } = overrides;
  const enrollment =
    enrollmentOverride === undefined
      ? null
      : enrollmentOverride === null
        ? null
        : {
            ...enrollmentOverride,
            offlineBackup:
              enrollmentOverride.offlineBackup ?? emptyEnrollmentOfflineBackup,
          };
  return {
    serverUrl: "https://pharmacy.example/api/v1",
    serverUrlEditable: true,
    enrollment,
    operator: null,
    staffSession: null,
    pin: null,
    locked: false,
    counterStaff: [],
    branches: [],
    windowsSession: { protocol: "console", remoteSession: false },
    ...rest,
  };
}

/** Stubs the preload bridge: every call resolves, unless a test gives it something better. */
export function stubPos(
  calls: Record<string, (...args: never[]) => unknown> = {},
) {
  const pos = new Proxy({} as Record<string, unknown>, {
    get: (target, name) => {
      // Not a thenable: an async helper may return the stub.
      if (typeof name !== "string" || name === "then") return undefined;
      if (!(name in target)) {
        const impl = calls[name] ?? (() => new Promise(() => undefined));
        target[name] = jest.fn(impl as (...args: unknown[]) => unknown);
      }
      return target[name];
    },
  });
  Object.defineProperty(window, "pos", {
    value: pos,
    configurable: true,
    writable: true,
  });
  return pos as unknown as Record<string, jest.Mock>;
}

/** Renders with its own key map whose clock moves at a person's pace, so nothing reads as a scan. */
export function renderWithKeys(ui: ReactElement) {
  let now = 0;
  const map = new KeyMap(() => (now += 200));
  return { map, ...render(<KeyMapProvider map={map}>{ui}</KeyMapProvider>) };
}

/** A key press on whatever has focus (the body, if nothing does). */
export function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body;
  return fireEvent.keyDown(target, { key, ...init });
}
