export type NmraImportPreview = {
  totalRows: number;
  create: number;
  update: number;
  skip: number;
  errors: Array<{ registrationNo?: string; message: string }>;
  sampleCreates: Array<{ registrationNo: string; name: string; brandName: string | null }>;
  sampleUpdates: Array<{
    registrationNo: string;
    name: string;
    existingName: string;
  }>;
};

export type NmraImportResult = {
  parsed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ registrationNo?: string; message: string }>;
  categoryMapsAdded: number;
  tagsTouched: number;
};
