import { OnboardingDraftService } from "./onboarding-draft.service";

describe("OnboardingDraftService", () => {
  it("prefills Sri Lankan defaults for a verified owner", async () => {
    const prisma = { ownerRegistration: { findUnique: jest.fn().mockResolvedValue({ onboardingDraft: null, email: "owner@example.com", phone: null }), update: jest.fn() } };
    const result = await new OnboardingDraftService(prisma as never).get("registration-id");
    expect(result.draft).toEqual(expect.objectContaining({ currentStep: 1, country: "LK", currency: "LKR", timezone: "Asia/Colombo", businessEmail: "owner@example.com" }));
    expect(result.nextPath).toBe("/onboarding/pharmacy");
  });

  it("merges and persists a resumable draft", async () => {
    const prisma = { ownerRegistration: { findUnique: jest.fn().mockResolvedValue({ onboardingDraft: { businessName: "Serendib Pharmacy", currentStep: 1 }, email: "owner@example.com", phone: null }), update: jest.fn().mockResolvedValue({}) } };
    const service = new OnboardingDraftService(prisma as never);
    const result = await service.save("registration-id", { currentStep: 2, branchName: "Matale Main" });
    expect(prisma.ownerRegistration.update).toHaveBeenCalledWith({ where: { id: "registration-id" }, data: { onboardingDraft: expect.objectContaining({ businessName: "Serendib Pharmacy", branchName: "Matale Main", currentStep: 2 }) } });
    expect(result.nextPath).toBe("/onboarding/branch");
  });
});
