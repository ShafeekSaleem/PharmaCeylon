import { render, screen } from "@testing-library/react";
import { PosPharmacistPinModal } from "./pos-pharmacist-pin-modal";

describe("PosPharmacistPinModal", () => {
  it("says why nobody can co-sign: the list holds only pharmacists with a current SLMC registration", async () => {
    render(
      <PosPharmacistPinModal
        open
        onClose={jest.fn()}
        onApprove={jest.fn()}
        onError={jest.fn()}
        loadApprovers={async () => []}
      />,
    );
    expect(await screen.findByText(/has a current SLMC registration, so nobody can co-sign/)).toBeInTheDocument();
    expect(screen.queryByText(/assigned to this branch/)).not.toBeInTheDocument();
  });
});
