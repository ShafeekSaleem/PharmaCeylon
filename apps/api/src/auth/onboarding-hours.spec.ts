import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { WEEKDAYS } from "@pharmaceylon/shared";
import { onboardingHours } from "./onboarding-hours";
import { OnboardingDraftService } from "./onboarding-draft.service";
import { SaveOnboardingDraftDto } from "./dto/save-onboarding-draft.dto";

const hours = () => ({
  schemaVersion: 1,
  weekly: Object.fromEntries(
    WEEKDAYS.map((day) => [day, { mode: "open_24h" }]),
  ),
  exceptions: [],
  mandatory: null,
});

it("reuses W7 validation and leaves omitted hours unset rather than inventing restrictions", () => {
  expect(onboardingHours(undefined)).toBeNull();
  expect(onboardingHours(null)).toBeNull();
  expect(onboardingHours(hours())).toEqual(hours());
  expect(
    onboardingHours({
      ...hours(),
      weekly: {
        ...hours().weekly,
        mon: { mode: "hours", ranges: [{ opens: "20:00", closes: "06:00" }] },
      },
    }),
  ).toMatchObject({ mandatory: null });
});
it.each([
  {},
  [],
  { ...hours(), mandatory: [] },
  { ...hours(), extra: true },
  { ...hours(), weekly: { mon: { mode: "closed" } } },
  {
    ...hours(),
    exceptions: [
      {
        date: "2026-02-30",
        label: "Holiday",
        hours: { mode: "closed" },
        source: "owner",
        holidayKey: null,
      },
    ],
  },
])("rejects malformed hours and hard-limit shortcuts: %j", (input) => {
  expect(() => onboardingHours(input)).toThrow(BadRequestException);
});
it("persists structured hours and counter count in a resumable draft, with no stock writes", async () => {
  const prisma = {
    ownerRegistration: {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          onboardingDraft: { currentStep: 1 },
          email: "owner@it.test",
          phone: null,
        }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const service = new OnboardingDraftService(prisma as never);
  await service.save("registration", {
    currentStep: 2,
    branchHours: hours(),
    plannedCounterCount: 3,
  });
  expect(prisma.ownerRegistration.update).toHaveBeenCalledWith({
    where: { id: "registration" },
    data: {
      onboardingDraft: expect.objectContaining({
        branchHours: hours(),
        plannedCounterCount: 3,
        currentStep: 2,
      }),
    },
  });
  await expect(
    service.save("registration", {
      currentStep: 2,
      branchHours: { ...hours(), mandatory: [] },
    }),
  ).rejects.toThrow(BadRequestException);
  expect(prisma.ownerRegistration.update).toHaveBeenCalledTimes(1);
});
it("rejects invalid planning counts and non-object hours at the request boundary", async () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  for (const dto of [
    { plannedCounterCount: 0 },
    { plannedCounterCount: 101 },
    { plannedCounterCount: 1.5 },
    { branchHours: [] },
  ]) {
    await expect(
      pipe.transform(
        { currentStep: 2, ...dto },
        { type: "body", metatype: SaveOnboardingDraftDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  }
});
