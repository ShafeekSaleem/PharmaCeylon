import { fireEvent, render, screen } from "@testing-library/react";
import { HeldDeliveryBanner } from "./held-delivery-banner";
import type { HeldDelivery, PurchaseOrderDetail } from "../types";
const held = { id: "held", status: "approved", executionApprovalId: "approval-id", reasons: ["over_delivery"], requestedAt: "2026-10-26T00:00:00Z",
  requester: { fullName: "Clerk" }, delivery: { receivedOn: "2026-10-26", lines: [] } } as unknown as HeldDelivery;
const order = { items: [] } as unknown as PurchaseOrderDetail;

it("offers receiving staff separate posting without approval controls", () => {
  const post = jest.fn(); const review = jest.fn();
  render(<HeldDeliveryBanner held={held} order={order} canDecide={false} canPost busy={false}
    onPost={post} onReview={review} onReject={jest.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Post receipt" }));
  expect(post).toHaveBeenCalledTimes(1); expect(review).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Review approval" })).not.toBeInTheDocument();
});

it("keeps approval and posting distinct for an authorized reviewer", () => {
  render(<HeldDeliveryBanner held={{ ...held, status: "awaiting_approval" }} order={order} canDecide canPost busy={false}
    onPost={jest.fn()} onReview={jest.fn()} onReject={jest.fn()} />);
  expect(screen.getByRole("button", { name: "Review delivery" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Post receipt" })).not.toBeInTheDocument();
});
