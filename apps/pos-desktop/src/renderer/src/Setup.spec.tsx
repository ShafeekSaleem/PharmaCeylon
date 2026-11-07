/** @jest-environment jsdom */
import { afterEach, describe, expect, it } from "@jest/globals";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  deviceState,
  ids,
  press,
  renderWithKeys,
  stubPos,
} from "../test/harness";
import { SetupScreen } from "./Setup";

afterEach(cleanup);

const operator = {
  userId: ids.ana,
  fullName: "Ana Perera",
  email: "ana@example.com",
  branchRoles: [{ branchId: ids.branch, role: "manager" }],
};
const counter = {
  registerId: ids.register,
  tillId: ids.till,
  label: "Counter 1",
  isActive: true,
  terminal: null,
};

async function renderEnroll() {
  const pos = stubPos({
    listCounters: async () => ({ ok: true, value: [counter] }),
    createCounter: async () => ({
      ok: true,
      value: { ...counter, registerId: ids.register2, label: "Counter 4" },
    }),
  });
  const state = deviceState({
    operator,
    branches: [{ id: ids.branch, code: "C03", name: "Colombo 03" }],
  });
  await act(async () => {
    renderWithKeys(
      <SetupScreen
        state={state}
        onState={() => undefined}
        api={null}
        info={null}
        readiness={null}
      />,
    );
  });
  return pos;
}

describe("Setup's Ctrl+Enter, now on the key map", () => {
  it("enrolls from any field once the form is complete", async () => {
    const pos = await renderEnroll();
    const label = screen.getByLabelText(/Name for this computer/);
    label.focus();
    press("Enter", { ctrlKey: true });
    expect(pos.enroll).not.toHaveBeenCalled();

    fireEvent.change(label, { target: { value: "Front desk PC" } });
    await act(async () => void press("Enter", { ctrlKey: true }));
    expect(pos.enroll).toHaveBeenCalledWith({
      branchId: ids.branch,
      registerId: ids.register,
      label: "Front desk PC",
    });
  });

  it("shows the key on the enroll button", async () => {
    await renderEnroll();
    expect(
      screen
        .getByRole("button", { name: /Enroll this computer/ })
        .querySelector("kbd")?.textContent,
    ).toBe("Ctrl ↵");
  });

  it("adds a counter with Enter in its name, and only Ctrl+Enter sends the form", async () => {
    const pos = await renderEnroll();
    act(() => screen.getByRole("button", { name: /Add a counter/ }).click());
    const name = screen.getByLabelText("New counter name");
    fireEvent.change(name, { target: { value: "Counter 4" } });
    await act(async () => void press("Enter"));
    expect(pos.createCounter).toHaveBeenCalledWith({
      branchId: ids.branch,
      label: "Counter 4",
    });
    expect(pos.enroll).not.toHaveBeenCalled();
  });

  it("cancels adding a counter with Esc", async () => {
    await renderEnroll();
    act(() => screen.getByRole("button", { name: /Add a counter/ }).click());
    expect(screen.getByLabelText("New counter name")).toBeTruthy();
    act(() => void press("Escape"));
    expect(screen.queryByLabelText("New counter name")).toBeNull();
  });

  it("signs in with Ctrl+Enter on the sign-in step", async () => {
    const pos = stubPos();
    renderWithKeys(
      <SetupScreen
        state={deviceState()}
        onState={() => undefined}
        api={null}
        info={null}
        readiness={null}
      />,
    );
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "ana@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" },
    });
    screen.getByLabelText("Email").focus();
    act(() => void press("Enter", { ctrlKey: true }));
    expect(pos.signIn).toHaveBeenCalledWith({
      email: "ana@example.com",
      password: "secret",
    });
  });
});
