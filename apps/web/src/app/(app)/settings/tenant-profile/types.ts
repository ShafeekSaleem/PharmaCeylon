export type TenantProfile = {
  code: string;
  displayName: string;
  legalName: string;
  complianceRegion: string;
  timezone: string;
  currency: string;
  dateFormat: string;
  fiscalYearStartMonth: number;
  businessRegistrationNo: string | null;
  logoUrl: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  email: string | null;
  phone: string | null;
  taxIdentificationNo: string | null;
  vatRegistrationNo: string | null;
};

export type UpdateTenantProfileInput = Partial<
  Omit<TenantProfile, "code" | "timezone">
>;
