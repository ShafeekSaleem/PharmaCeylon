import { render, screen } from "@testing-library/react";
import { CounterHandoff } from "./counter-handoff";

describe("CounterHandoff", () => {
  it("says an approved document waits at the counter, with the branch and who can do it", () => {
    render(
      <CounterHandoff
        branchName="Colombo 03"
        action="Receive the goods"
        whoCan={["Pharmacist", "Inventory clerk", "Manager"]}
      />,
    );
    const handoff = screen.getByRole("status");
    expect(handoff).toHaveTextContent("Approved — waiting at the counter");
    expect(handoff).toHaveTextContent(
      "Receive the goods in PharmaCeylon POS at Colombo 03. Pharmacist, Inventory clerk or Manager can do it.",
    );
    expect(screen.getByText("Colombo 03").tagName).toBe("STRONG");
  });

  it("reads without an action or a list of people", () => {
    render(<CounterHandoff branchName="Kandy" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Approved — waiting at the counterIn PharmaCeylon POS at Kandy.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("can do it");
  });

  it("joins two people with 'or'", () => {
    render(<CounterHandoff branchName="Galle" whoCan={["Pharmacist", "Manager"]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Pharmacist or Manager can do it.");
  });

  it("replaces an execute button at a live branch without naming POS twice", () => {
    render(
      <CounterHandoff
        variant="counter_only"
        branchName="Colombo 03"
        action="Post the stocktake"
        whoCan={["Manager"]}
      />,
    );
    const handoff = screen.getByRole("status");
    expect(handoff).toHaveTextContent("Do this at the counter in PharmaCeylon POS.");
    expect(handoff).toHaveTextContent("Post the stocktake at Colombo 03. Manager can do it.");
    expect(handoff).not.toHaveTextContent("Approved");
  });
});
