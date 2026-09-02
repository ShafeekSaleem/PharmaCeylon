import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SaveOnboardingDraftDto } from "./dto/save-onboarding-draft.dto";

export type OnboardingDraft = Omit<SaveOnboardingDraftDto, "currentStep"> & { currentStep: number };

@Injectable()
export class OnboardingDraftService {
  constructor(private readonly prisma: PrismaService) {}

  async get(registrationId: string) {
    const registration = await this.prisma.ownerRegistration.findUnique({
      where: { id: registrationId },
      select: { onboardingDraft: true, email: true, phone: true },
    });
    if (!registration) throw new NotFoundException("Owner registration not found");
    const saved = asDraft(registration.onboardingDraft);
    const draft: OnboardingDraft = {
      country: "LK",
      currency: "LKR",
      timezone: "Asia/Colombo",
      businessEmail: registration.email,
      businessPhone: registration.phone ?? undefined,
      migrationMode: "fresh",
      paymentMethods: ["cash", "card"],
      dateFormat: "DD/MM/YYYY",
      ...saved,
      currentStep: saved.currentStep ?? 1,
    };
    return { draft, nextPath: pathForStep(draft.currentStep) };
  }

  async save(registrationId: string, input: SaveOnboardingDraftDto) {
    const current = await this.get(registrationId);
    const draft = compact({ ...current.draft, ...input, currentStep: input.currentStep });
    await this.prisma.ownerRegistration.update({
      where: { id: registrationId },
      data: { onboardingDraft: draft as Prisma.InputJsonValue },
    });
    return { draft, nextPath: pathForStep(draft.currentStep) };
  }
}

function asDraft(value: Prisma.JsonValue | null): Partial<OnboardingDraft> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<OnboardingDraft>)
    : {};
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function pathForStep(step: number): string {
  return ["/onboarding/pharmacy", "/onboarding/branch", "/onboarding/preferences", "/onboarding/review"][Math.min(4, Math.max(1, step)) - 1];
}
