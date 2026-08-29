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
};

export type UpdateTenantProfileInput = Partial<
  Omit<TenantProfile, "code" | "timezone">
>;
