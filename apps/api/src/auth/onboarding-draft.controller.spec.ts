import { OnboardingDraftController } from "./onboarding-draft.controller";

describe("OnboardingDraftController", () => {
  const owner = {
    registrationId: "registration-id",
  } as never;
  const file = {
    mimetype: "image/png",
    size: 128,
    buffer: Buffer.from("logo"),
  } as Express.Multer.File;

  function setup(existingLogo?: string | null) {
    const drafts = {
      assertOpen: jest.fn(),
      get: jest.fn().mockResolvedValue({
        draft: {
          currentStep: 1,
          businessName: "Royal Pharmacy",
          businessLogoUrl: existingLogo,
        },
      }),
      save: jest
        .fn()
        .mockImplementation((_id, draft) => Promise.resolve({ draft })),
    };
    const uploads = {
      uploadImage: jest.fn().mockResolvedValue({
        url: "/uploads/onboarding-logos/new-logo.webp",
        thumbUrl: "/uploads/onboarding-logos/new-logo_thumb.webp",
      }),
      deleteImage: jest.fn().mockResolvedValue(undefined),
    };

    return {
      controller: new OnboardingDraftController(
        drafts as never,
        uploads as never,
        {} as never,
        {} as never,
        {} as never,
      ),
      drafts,
      uploads,
    };
  }

  it("stores the uploaded logo and removes the previous onboarding logo", async () => {
    const previous = "/uploads/onboarding-logos/previous-logo.webp";
    const { controller, drafts, uploads } = setup(previous);

    await expect(controller.uploadLogo(owner, file)).resolves.toEqual({
      url: "/uploads/onboarding-logos/new-logo.webp",
      thumbUrl: "/uploads/onboarding-logos/new-logo_thumb.webp",
    });
    expect(uploads.uploadImage).toHaveBeenCalledWith(file, "onboarding-logos");
    expect(drafts.save).toHaveBeenCalledWith(
      "registration-id",
      expect.objectContaining({
        businessLogoUrl: "/uploads/onboarding-logos/new-logo.webp",
      }),
    );
    expect(uploads.deleteImage).toHaveBeenCalledWith(previous);
  });

  it("deletes a new upload if saving the draft fails", async () => {
    const { controller, drafts, uploads } = setup();
    drafts.save.mockRejectedValueOnce(new Error("save failed"));

    await expect(controller.uploadLogo(owner, file)).rejects.toThrow(
      "save failed",
    );
    expect(uploads.deleteImage).toHaveBeenCalledWith(
      "/uploads/onboarding-logos/new-logo.webp",
    );
  });

  it("clears and deletes the current onboarding logo", async () => {
    const previous = "/uploads/onboarding-logos/previous-logo.webp";
    const { controller, drafts, uploads } = setup(previous);

    await expect(controller.removeLogo(owner)).resolves.toEqual({ url: null });
    expect(drafts.save).toHaveBeenCalledWith(
      "registration-id",
      expect.objectContaining({ businessLogoUrl: null }),
    );
    expect(uploads.deleteImage).toHaveBeenCalledWith(previous);
  });
});
