import { BadRequestException } from "@nestjs/common";
import { validateBranchHours, type BranchHours } from "@pharmaceylon/shared";

/** Initial routine hours use W7's document. Hard limits need W7's dedicated confirmation flow. */
export function onboardingHours(input: unknown): BranchHours | null {
  if (input === undefined || input === null) return null;
  const parsed = validateBranchHours(input);
  if (!parsed.ok) throw new BadRequestException([...parsed.errors]);
  if (parsed.value.mandatory !== null) {
    throw new BadRequestException(
      "Set mandatory selling limits in Branch settings after creating the workspace.",
    );
  }
  return parsed.value;
}
