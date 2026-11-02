import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaymentEvidenceDownload } from "./payment-evidence-download";
import { apiFetch } from "@/lib/auth-client";
jest.mock("@/lib/auth-client", () => ({ apiFetch: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId: "branch-a", user: { id: "user-a", tenantId: "tenant-a" } }) }));
const mockFetch = apiFetch as jest.Mock;
it("downloads private evidence through authenticated fetch, not a public URL", async () => {
  const blob = new Blob(["document"]);
  mockFetch.mockResolvedValue({ ok: true, blob: async () => blob });
  URL.createObjectURL = jest.fn(() => "blob:private");
  URL.revokeObjectURL = jest.fn();
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(
    <PaymentEvidenceDownload
      evidence={{ id: "evidence-a", mediaType: "application/pdf" }}
    />,
  );
  fireEvent.click(screen.getByText("Download evidence"));
  await waitFor(() => expect(click).toHaveBeenCalled());
  expect(apiFetch).toHaveBeenCalledWith(
    "/purchasing/payment-evidence/evidence-a",
    { cache: "no-store" },
  );
  expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  click.mockRestore();
});
it("shows permission refusal without creating a downloadable document", async () => {
  mockFetch.mockResolvedValue({
    ok: false,
    text: async () => '{"message":"Forbidden"}',
  });
  URL.createObjectURL = jest.fn();
  render(
    <PaymentEvidenceDownload
      evidence={{ id: "evidence-a", mediaType: "application/pdf" }}
    />,
  );
  fireEvent.click(screen.getByText("Download evidence"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
