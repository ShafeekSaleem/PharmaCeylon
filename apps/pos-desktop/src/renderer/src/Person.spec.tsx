/** @jest-environment jsdom */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, cleanup } from "@testing-library/react";
import { useState } from "react";
import {
  deviceState,
  ids,
  press,
  renderWithKeys,
  stubPos,
} from "../test/harness";
import { KeyBinding, KeyScope } from "./keymap";
import { PersonPanel } from "./Person";

afterEach(cleanup);

const state = deviceState({
  staffSession: {
    workSessionId: ids.session,
    staffUserId: ids.ana,
    staffName: "Ana Perera",
    openedAt: new Date().toISOString(),
  },
  pin: { set: true, prepared: true, lockedUntil: null },
});

function Page({ onBack, onHold }: { onBack: () => void; onHold: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <KeyScope active>
      <KeyBinding keys="Escape" onKey={onBack} />
      <KeyBinding keys="F8" onKey={onHold} />
      {open && (
        <PersonPanel
          state={state}
          onState={() => undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </KeyScope>
  );
}

describe("the person panel", () => {
  it("takes the keys while open: Esc closes it first, then the page goes back", () => {
    stubPos();
    const onBack = jest.fn();
    const onHold = jest.fn();
    renderWithKeys(<Page onBack={onBack} onHold={onHold} />);
    press("F8");
    expect(onHold).not.toHaveBeenCalled();
    act(() => void press("Escape"));
    expect(onBack).not.toHaveBeenCalled();
    act(() => void press("Escape"));
    expect(onBack).toHaveBeenCalledTimes(1);
    press("F8");
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("locks with Ctrl+Enter, as its key hint says", () => {
    const pos = stubPos();
    renderWithKeys(
      <PersonPanel
        state={state}
        onState={() => undefined}
        onClose={() => undefined}
      />,
    );
    act(() => void press("Enter", { ctrlKey: true }));
    expect(pos.lock).toHaveBeenCalledTimes(1);
  });
});
