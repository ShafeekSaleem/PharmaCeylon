export type Branch = {
  id: string;
  code: string;
  name: string;
  city: string | null;
  addressLine1: string | null;
  phone: string | null;
  timezone: string;
  isActive: boolean;
};

export type CreateBranchInput = {
  code: string;
  name: string;
  city?: string;
  addressLine1?: string;
  phone?: string;
  timezone?: string;
};

export type UpdateBranchInput = Partial<CreateBranchInput> & { isActive?: boolean };
