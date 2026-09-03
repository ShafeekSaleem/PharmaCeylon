import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SaveOnboardingDraftDto } from "./dto/save-onboarding-draft.dto";
import type { VerifiedOwnerSession } from "./owner-registration.service";

export type OnboardingDraft = Omit<SaveOnboardingDraftDto, "currentStep"> & {
  currentStep: number;
};

@Injectable()
export class OnboardingDraftService {
  constructor(private readonly prisma: PrismaService) {}

  assertOpen(owner: VerifiedOwnerSession): void {
    if (owner.status === "completed") {
      throw new ConflictException("This workspace has already been created");
    }
  }

  async get(registrationId: string) {
    const registration = await this.prisma.ownerRegistration.findUnique({
      where: { id: registrationId },
      select: { onboardingDraft: true, email: true, phone: true },
    });
    if (!registration)
      throw new NotFoundException("Owner registration not found");
    const saved = asDraft(registration.onboardingDraft);
    const ownerPhone = splitPhone(registration.phone);
    const savedBusinessPhone = splitPhone(saved.businessPhone);
    const draft: OnboardingDraft = {
      country: "LK",
      currency: "LKR",
      timezone: "Asia/Colombo",
      businessEmail: registration.email,
      branchCountry: "LK",
      branchTimezone: "Asia/Colombo",
      branchPhoneCountryCode: "+94",
      migrationMode: "fresh",
      paymentMethods: ["cash", "card"],
      dateFormat: "DD/MM/YYYY",
      ...saved,
      businessPhoneCountryCode:
        saved.businessPhoneCountryCode ??
        savedBusinessPhone.code ??
        ownerPhone.code ??
        "+94",
      businessPhone:
        savedBusinessPhone.number ?? ownerPhone.number ?? undefined,
      currentStep: saved.currentStep ?? 1,
    };
    return { draft, nextPath: pathForStep(draft.currentStep) };
  }

  async save(registrationId: string, input: SaveOnboardingDraftDto) {
    const current = await this.get(registrationId);
    const draft = compact({
      ...current.draft,
      ...input,
      currentStep: Math.max(current.draft.currentStep, input.currentStep),
    });
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
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function pathForStep(step: number): string {
  return [
    "/onboarding/pharmacy",
    "/onboarding/branch",
    "/onboarding/preferences",
    "/onboarding/review",
  ][Math.min(4, Math.max(1, step)) - 1];
}

function splitPhone(value: unknown): { code?: string; number?: string } {
  if (typeof value !== "string" || !value.trim()) return {};
  const match = value.trim().match(/^(\+\d{1,4})\s*(.*)$/);
  if (!match) return { number: value.trim() };
  return { code: match[1], number: match[2] || undefined };
}
