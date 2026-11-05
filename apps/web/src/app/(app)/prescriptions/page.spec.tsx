import { render, screen, within } from "@testing-library/react";
import PrescriptionsPage from "./page";
import { apiJson } from "@/lib/auth-client";

jest.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId: "branch-a" }) }));

const base = {
  patientName: "Nimal Perera",
  doctorName: "Silva",
  doctorRegNo: "SLMC 9921",
  issuedOn: "2026-11-04T00:00:00.000Z",
  validUntil: null,
  notes: null,
  customer: null,
  _count: { sales: 0 },
};

beforeEach(() => {
  jest.mocked(apiJson).mockImplementation(async (path: string) => {
    if (!path.startsWith("/prescriptions/register?")) throw new Error(`Unexpected request ${path}`);
    return {
      items: [
        {
          ...base,
          id: "rx-1",
          rxNumber: "RX-00041",
          recordedBy: { id: "u-cashier", fullName: "Sachini Rathnayake" },
          checkedBy: { id: "u-pharm", fullName: "Dilshan Wickramasinghe", slmcNumber: "PH-1234" },
        },
        {
          ...base,
          id: "rx-2",
          rxNumber: "RX-00042",
          recordedBy: { id: "u-manager", fullName: "Kamal Fernando" },
          checkedBy: null,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 25,
    };
  });
});

describe("the prescription register", () => {
  it("shows who recorded each prescription and which pharmacist checked it, with their SLMC number", async () => {
    render(<PrescriptionsPage />);
    const cosigned = (await screen.findByText("RX-00041")).closest("tr")!;
    expect(screen.getByRole("columnheader", { name: /Recorded by/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Pharmacist checked by/ })).toBeTruthy();
    expect(within(cosigned).getByText("Sachini Rathnayake")).toBeTruthy();
    expect(within(cosigned).getByText("Dilshan Wickramasinghe")).toBeTruthy();
    expect(within(cosigned).getByText("SLMC PH-1234")).toBeTruthy();
  });

  it("says a prescription recorded on the web was not checked by a registered pharmacist", async () => {
    render(<PrescriptionsPage />);
    const web = (await screen.findByText("RX-00042")).closest("tr")!;
    expect(within(web).getByText("Kamal Fernando")).toBeTruthy();
    expect(within(web).getByText("Not checked")).toBeTruthy();
    expect(within(web).getByText(/no registration check/)).toBeTruthy();
  });
});
