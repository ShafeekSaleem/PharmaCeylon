import { act, render, screen, waitFor } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import { StockMovementTrendPanel } from "./stock-movement-trend-panel";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));

it("distinguishes unavailable movement data from zero activity and retries on dashboard refresh", async () => {
  const request = jest.mocked(apiJson);
  request.mockRejectedValueOnce(new Error("Offline"));
  render(<StockMovementTrendPanel branchId="main" />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Data unavailable"),
  );
  expect(
    screen.queryByText("No stock movements in this period."),
  ).not.toBeInTheDocument();
  request.mockResolvedValueOnce({
    period: "week",
    points: [],
    receivedTotal: 0,
    issuedTotal: 0,
    netTotal: 0,
  });
  act(() => window.dispatchEvent(new Event("dashboard:refresh")));
  await screen.findByText("No stock movements in this period.");
});
