import { fireEvent, render, screen } from "@testing-library/react";
import { UNSAVED_CHANGES_MESSAGE, useUnsavedChangesWarning } from "./use-unsaved-changes";

function Page({ dirty }: { dirty: boolean }) {
  useUnsavedChangesWarning(dirty);
  return (
    <>
      <a href="/dashboard">Dashboard</a>
      <a href="/dashboard" target="_blank">
        New tab
      </a>
      <a href="#preview">Jump</a>
    </>
  );
}

let confirmSpy: jest.SpyInstance;
beforeEach(() => {
  confirmSpy = jest.spyOn(window, "confirm");
});
afterEach(() => confirmSpy.mockRestore());

/** Fires a click and reports whether something stopped the navigation. */
function click(name: string, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  fireEvent(screen.getByRole("link", { name }), event);
  return event.defaultPrevented;
}

it("asks before following a link away from unsaved changes, and stays when told to", () => {
  confirmSpy.mockReturnValue(false);
  render(<Page dirty />);
  expect(click("Dashboard")).toBe(true);
  expect(confirmSpy).toHaveBeenCalledWith(UNSAVED_CHANGES_MESSAGE);
});

it("leaves when the person confirms", () => {
  confirmSpy.mockReturnValue(true);
  render(<Page dirty />);
  // jsdom doesn't navigate, so an unprevented click is the "leave" outcome.
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  const link = screen.getByRole("link", { name: "Dashboard" });
  link.addEventListener("click", (e) => e.preventDefault());
  fireEvent(link, event);
  expect(confirmSpy).toHaveBeenCalledTimes(1);
});

it("doesn't ask when nothing is unsaved, for a new tab, or for a spot on the same page", () => {
  render(<Page dirty={false} />);
  expect(click("Dashboard")).toBe(false);
  expect(confirmSpy).not.toHaveBeenCalled();
});

it("lets new tabs and same-page links through even with unsaved changes", () => {
  confirmSpy.mockReturnValue(false);
  render(<Page dirty />);
  expect(click("New tab")).toBe(false);
  expect(click("Dashboard", { ctrlKey: true })).toBe(false);
  expect(click("Jump")).toBe(false);
  expect(confirmSpy).not.toHaveBeenCalled();
});

it("asks the browser to warn on close or reload only while there are unsaved changes", () => {
  const { rerender } = render(<Page dirty />);
  const dirtyEvent = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirtyEvent);
  expect(dirtyEvent.defaultPrevented).toBe(true);

  rerender(<Page dirty={false} />);
  const cleanEvent = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(cleanEvent);
  expect(cleanEvent.defaultPrevented).toBe(false);
});
