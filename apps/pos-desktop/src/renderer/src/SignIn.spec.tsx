/** @jest-environment jsdom */
import { afterEach, describe, expect, it } from "@jest/globals";
import { act, cleanup, screen } from "@testing-library/react";
import {
  deviceState,
  emptyEnrollmentOfflineBackup,
  ids,
  press,
  renderWithKeys,
  stubPos,
} from "../test/harness";
import { SignInScreen } from "./SignIn";

afterEach(cleanup);

const state = deviceState({
  enrollment: {
    status: "active",
    branchId: ids.branch,
    branchName: "Colombo 03",
    branchCode: "C03",
    registerId: ids.register,
    tillId: ids.till,
    counterLabel: "Counter 1",
    label: "Front desk PC",
    terminalId: ids.till,
    enrollmentId: ids.register,
    enrolledAt: null,
    enrolledByUserId: ids.ana,
    enrolledByName: "Branch enroller",
    offlineBackup: emptyEnrollmentOfflineBackup,
  },
  counterStaff: [
    {
      staffUserId: ids.ana,
      staffName: "Ana Perera",
      role: "cashier",
      state: "ready",
      lockedUntil: null,
    },
  ],
});

function renderPad() {
  const pos = stubPos();
  renderWithKeys(
    <SignInScreen
      state={state}
      onState={() => undefined}
      api={null}
      printer={null}
    />,
  );
  return pos;
}

const digits = () =>
  screen
    .getByRole("status", { name: /digits entered/ })
    .getAttribute("aria-label");

describe("the PIN pad's keys, now on the key map", () => {
  it("types digits, deletes with Backspace and signs in with Enter", () => {
    const pos = renderPad();
    for (const key of ["1", "2", "3", "4", "5"]) press(key);
    expect(digits()).toBe("5 digits entered");
    press("Backspace");
    expect(digits()).toBe("4 digits entered");
    act(() => void press("Enter"));
    expect(pos.pinSignIn).toHaveBeenCalledWith({
      staffUserId: ids.ana,
      pin: "1234",
    });
  });

  it("stops at eight digits and does not submit a short PIN", () => {
    const pos = renderPad();
    for (const key of "123456789") press(key);
    expect(digits()).toBe("8 digits entered");
    for (let i = 0; i < 6; i++) press("Backspace");
    press("Enter");
    expect(pos.pinSignIn).not.toHaveBeenCalled();
  });

  it("ignores digits typed with Ctrl or Alt", () => {
    renderPad();
    press("1", { ctrlKey: true });
    press("2", { altKey: true });
    expect(digits()).toBe("0 digits entered");
  });

  it("leaves Enter to a focused button outside the pad", () => {
    const pos = renderPad();
    for (const key of "1234") press(key);
    screen.getByRole("button", { name: /Someone else/ }).focus();
    press("Enter");
    expect(pos.pinSignIn).not.toHaveBeenCalled();
  });

  it("goes back from the password form to the PIN pad with Esc", () => {
    renderPad();
    act(() => screen.getByRole("button", { name: /Someone else/ }).click());
    expect(screen.queryByRole("status", { name: /digits entered/ })).toBeNull();
    // Typing in the form is typing, not PIN digits.
    screen.getByLabelText("Email").focus();
    press("1");
    act(() => void press("Escape"));
    expect(digits()).toBe("0 digits entered");
  });
});
