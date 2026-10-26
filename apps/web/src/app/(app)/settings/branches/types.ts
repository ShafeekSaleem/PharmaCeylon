import type { BranchHoursOrigin } from "@pharmaceylon/shared";

export type Branch = {
  id: string;
  code: string;
  name: string;
  city: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  district: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  pharmacyLicenceNo: string | null;
  pharmacyLicenceExpiry: string | null;
  responsiblePharmacist: string | null;
  pharmacistSlmcNo: string | null;
  /** Hours as typed before structured hours existed; read-only now. */
  legacyOpeningHours: string | null;
  /** null = no hours yet; "legacy_text" = read from the old text, not yet checked by a person. */
  operatingHoursOrigin: BranchHoursOrigin | null;
  operatingHoursVersion: number;
  timezone: string;
  isActive: boolean;
};

export type CreateBranchInput = {
  code: string;
  name: string;
  city?: string;
  addressLine1?: string;
  addressLine2?: string;
  district?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  pharmacyLicenceNo?: string;
  pharmacyLicenceExpiry?: string;
  responsiblePharmacist?: string;
  pharmacistSlmcNo?: string;
  timezone?: string;
};

export type UpdateBranchInput = {
  [K in keyof CreateBranchInput]?: CreateBranchInput[K] | null;
} & { isActive?: boolean };
