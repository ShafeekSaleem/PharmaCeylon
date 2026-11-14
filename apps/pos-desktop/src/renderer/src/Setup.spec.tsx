/** @jest-environment jsdom */
import { afterEach, describe, expect, it } from "@jest/globals";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
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
  hasHistory: false,
  hasOpenShift: false,
  terminal: null,
};

async function renderEnroll(extra: Record<string, (...args: never[]) => unknown> = {}) {
  const pos = stubPos({
    listCounters: async () => ({ ok: true, value: [counter] }),
    ...extra,
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

describe("fixing a mistaken counter (#180)", () => {
  const used = {
    ...counter,
    registerId: ids.register2,
    label: "Old till",
    hasHistory: true,
  };
  const enrolledHere = {
    ...counter,
    registerId: "55555555-5555-4555-8555-555555555555",
    label: "Pharmacy till",
    hasHistory: true,
    terminal: {
      terminalId: "66666666-6666-4666-8666-666666666666",
      label: "DISPENSARY-PC",
      enrollmentId: null,
      enrolledAt: 0,
    },
  };
  const open = () =>
    act(() =>
      screen.getByRole("button", { name: /Rename, stop using or delete/ }).click(),
    );
  const group = (name: string) => screen.getByRole("group", { name });

  it("only lists counters in use in the picker, and asks the server for them", async () => {
    const stopped = { ...counter, registerId: ids.register2, label: "Gone", isActive: false };
    const pos = await renderEnroll({
      listCounters: async () => ({ ok: true, value: [counter, stopped] }),
    });
    expect(pos.listCounters).toHaveBeenCalledWith({ branchId: ids.branch, includeInactive: false });
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("renames a counter", async () => {
    const pos = await renderEnroll({
      updateCounter: async () => ({ ok: true, value: { ...counter, label: "Front" } }),
    });
    await act(async () => open());
    act(() => within(group("Counter 1")).getByRole("button", { name: "Rename" }).click());
    fireEvent.change(screen.getByLabelText("Counter name"), { target: { value: "Front" } });
    await act(async () => screen.getByRole("button", { name: "Save name" }).click());
    expect(pos.updateCounter).toHaveBeenCalledWith({
      branchId: ids.branch,
      registerId: ids.register,
      label: "Front",
    });
  });

  it("deletes a never-used counter only after confirming, and offers no delete once it has history", async () => {
    const pos = await renderEnroll({
      listCounters: async () => ({ ok: true, value: [counter, used] }),
      deleteCounter: async () => ({ ok: true, value: {} }),
    });
    await act(async () => open());
    expect(within(group("Old till")).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(group("Old till")).getByText(/can only be stopped/)).toBeTruthy();
    act(() => within(group("Counter 1")).getByRole("button", { name: "Delete" }).click());
    expect(pos.deleteCounter).not.toHaveBeenCalled();
    await act(async () => screen.getByRole("button", { name: "Yes, delete it" }).click());
    expect(pos.deleteCounter).toHaveBeenCalledWith({ branchId: ids.branch, registerId: ids.register });
  });

  it("stops using a counter after confirming", async () => {
    const pos = await renderEnroll({
      updateCounter: async () => ({ ok: true, value: { ...counter, isActive: false } }),
    });
    await act(async () => open());
    act(() => within(group("Counter 1")).getByRole("button", { name: "Stop using" }).click());
    await act(async () => screen.getByRole("button", { name: "Yes, stop using it" }).click());
    expect(pos.updateCounter).toHaveBeenCalledWith({
      branchId: ids.branch,
      registerId: ids.register,
      isActive: false,
    });
  });

  it("will not stop a counter that has a computer, and says why", async () => {
    await renderEnroll({
      listCounters: async () => ({ ok: true, value: [enrolledHere] }),
    });
    await act(async () => open());
    const row = group("Pharmacy till");
    expect(within(row).getByRole("button", { name: "Stop using" })).toHaveProperty("disabled", true);
    expect(within(row).getByText(/computer is still set up here/)).toBeTruthy();
  });

  it("shows the server's reason when a change is refused", async () => {
    await renderEnroll({
      updateCounter: async () => ({
        ok: false,
        error: { code: "X", message: "Another counter at this branch already has that name." },
      }),
    });
    await act(async () => open());
    act(() => within(group("Counter 1")).getByRole("button", { name: "Rename" }).click());
    fireEvent.change(screen.getByLabelText("Counter name"), { target: { value: "Dup" } });
    await act(async () => screen.getByRole("button", { name: "Save name" }).click());
    expect(screen.getByRole("alert").textContent).toMatch(/already has that name/);
  });

  it("starts using a stopped counter again", async () => {
    const stopped = { ...counter, isActive: false };
    const pos = await renderEnroll({
      listCounters: async () => ({ ok: true, value: [stopped] }),
      updateCounter: async () => ({ ok: true, value: counter }),
    });
    await act(async () => open());
    await act(async () =>
      within(group("Counter 1")).getByRole("button", { name: "Use again" }).click(),
    );
    expect(pos.updateCounter).toHaveBeenCalledWith({
      branchId: ids.branch,
      registerId: ids.register,
      isActive: true,
    });
  });
});
