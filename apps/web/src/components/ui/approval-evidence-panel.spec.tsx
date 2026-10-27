import { render, screen, within } from "@testing-library/react";
import { ApprovalEvidencePanel, STALE_APPROVAL_MESSAGE } from "./approval-evidence-panel";

function valueOf(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" });
  return term.nextElementSibling as HTMLElement;
}

describe("ApprovalEvidencePanel", () => {
  it("shows the approved version, the status and each person separately", () => {
    render(
      <ApprovalEvidencePanel
        approvedVersion={3}
        currentVersion={3}
        status="approved"
        statusLabel="Approved"
        requester={{ name: "Nimal Perera", at: "2026-10-26T09:15:00Z" }}
        approver={{ name: "Ayesha Fernando", at: "2026-10-26T11:40:00Z" }}
        executor={{ name: "Kamal Silva", at: "2026-10-27T08:05:00Z" }}
      />,
    );
    const panel = screen.getByRole("region", { name: "Approval" });
    expect(within(panel).getByText("Approved")).toBeInTheDocument();
    expect(valueOf("Approved version")).toHaveTextContent("Version 3");
    expect(valueOf("Requested by")).toHaveTextContent("Nimal Perera");
    expect(valueOf("Approved by")).toHaveTextContent("Ayesha Fernando");
    expect(valueOf("Executed by")).toHaveTextContent("Kamal Silva");
    expect(valueOf("Executed by").querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-10-27T08:05:00Z",
    );
    expect(screen.queryByText(STALE_APPROVAL_MESSAGE)).not.toBeInTheDocument();
  });

  it("says who hasn't acted yet while it waits", () => {
    render(
      <ApprovalEvidencePanel
        approvedVersion={null}
        status="awaiting_approval"
        requester={{ name: "Nimal Perera" }}
        approver={null}
        executor={null}
      />,
    );
    expect(valueOf("Approved version")).toHaveTextContent("Not approved yet");
    expect(valueOf("Approved by")).toHaveTextContent("Not approved yet");
    expect(valueOf("Executed by")).toHaveTextContent("Not done yet");
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
  });

  it("warns when the document changed materially after approval", () => {
    render(
      <ApprovalEvidencePanel
        approvedVersion={2}
        currentVersion={3}
        status="approved"
        requester={{ name: "Nimal Perera" }}
        approver={{ name: "Ayesha Fernando" }}
        executor={null}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Changed since approval — needs fresh approval.",
    );
    expect(valueOf("Approved version")).toHaveTextContent("Version 2 · now version 3");
  });

  it("keeps the approval when only notes changed (material version unchanged)", () => {
    render(
      <ApprovalEvidencePanel
        approvedVersion={2}
        currentVersion={2}
        status="approved"
        requester={{ name: "Nimal Perera" }}
        approver={{ name: "Ayesha Fernando" }}
        executor={null}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("names a person once per part even when they hold two", () => {
    render(
      <ApprovalEvidencePanel
        approvedVersion={1}
        status="approved"
        requester={{ name: "Owner One" }}
        approver={{ name: "Owner One" }}
        executor={null}
        title="Delivery approval"
      />,
    );
    const panel = screen.getByRole("region", { name: "Delivery approval" });
    expect(within(panel).getAllByText("Owner One")).toHaveLength(2);
  });
});
