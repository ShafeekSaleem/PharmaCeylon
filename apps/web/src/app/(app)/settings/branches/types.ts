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
  openingHours: string | null;
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
  openingHours?: string;
  timezone?: string;
};

export type UpdateBranchInput = {
  [K in keyof CreateBranchInput]?: CreateBranchInput[K] | null;
} & { isActive?: boolean };
