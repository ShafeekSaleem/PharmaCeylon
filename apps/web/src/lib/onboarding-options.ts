export type ChoiceOption = {
  value: string;
  label: string;
  shortLabel?: string;
};

export type CountryChoice = ChoiceOption & {
  currency: string;
  timezone: string;
  phoneCode: string;
};

export const COUNTRY_OPTIONS: CountryChoice[] = [
  {
    value: "LK",
    label: "Sri Lanka",
    currency: "LKR",
    timezone: "Asia/Colombo",
    phoneCode: "+94",
  },
  {
    value: "IN",
    label: "India",
    currency: "INR",
    timezone: "Asia/Kolkata",
    phoneCode: "+91",
  },
  {
    value: "AE",
    label: "United Arab Emirates",
    currency: "AED",
    timezone: "Asia/Dubai",
    phoneCode: "+971",
  },
  {
    value: "SG",
    label: "Singapore",
    currency: "SGD",
    timezone: "Asia/Singapore",
    phoneCode: "+65",
  },
  {
    value: "GB",
    label: "United Kingdom",
    currency: "GBP",
    timezone: "Europe/London",
    phoneCode: "+44",
  },
  {
    value: "AU",
    label: "Australia",
    currency: "AUD",
    timezone: "Australia/Sydney",
    phoneCode: "+61",
  },
  {
    value: "CA",
    label: "Canada",
    currency: "CAD",
    timezone: "America/Toronto",
    phoneCode: "+1",
  },
  {
    value: "US",
    label: "United States",
    currency: "USD",
    timezone: "America/New_York",
    phoneCode: "+1",
  },
];

/**
 * Currency is LKR-only for now.
 *
 * The app has no shared currency formatter — roughly forty screens, receipts and
 * reports write the rupee symbol as a literal. Offering INR/AED/GBP here meant a
 * tenant could pick a currency and then be shown, and print, rupees everywhere:
 * the one combination that produces genuinely wrong documents.
 *
 * `COUNTRY_OPTIONS` deliberately keeps its full list — timezone and phone code
 * are honoured for real — but `countryDefaults()` no longer changes currency.
 * Restore the other entries here once a `formatCurrency` helper driven by
 * `Tenant.currency` exists and those literals are gone.
 */
export const CURRENCY_OPTIONS: ChoiceOption[] = [
  { value: "LKR", label: "LKR — Sri Lankan Rupee" },
];

/** The only currency the app can render correctly today. */
export const DEFAULT_CURRENCY = "LKR";

export const TIMEZONE_OPTIONS: ChoiceOption[] = [
  { value: "Asia/Colombo", label: "Asia/Colombo (UTC+05:30)" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata (UTC+05:30)" },
  { value: "Asia/Dubai", label: "Asia/Dubai (UTC+04:00)" },
  { value: "Asia/Singapore", label: "Asia/Singapore (UTC+08:00)" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "Australia/Sydney", label: "Australia/Sydney" },
  { value: "America/Toronto", label: "America/Toronto" },
  { value: "America/New_York", label: "America/New York" },
  { value: "America/Los_Angeles", label: "America/Los Angeles" },
  { value: "UTC", label: "UTC" },
];

export const PHONE_CODE_OPTIONS: ChoiceOption[] = COUNTRY_OPTIONS.reduce<
  ChoiceOption[]
>((options, country) => {
  if (!options.some((option) => option.value === country.phoneCode)) {
    options.push({
      value: country.phoneCode,
      label: `${country.label} (${country.phoneCode})`,
      shortLabel: `${country.value}  ${country.phoneCode}`,
    });
  }
  return options;
}, []);

export const PROVINCE_OPTIONS: ChoiceOption[] = [
  "Central Province",
  "Eastern Province",
  "North Central Province",
  "Northern Province",
  "North Western Province",
  "Sabaragamuwa Province",
  "Southern Province",
  "Uva Province",
  "Western Province",
].map((value) => ({ value, label: value }));

const DISTRICTS_BY_PROVINCE: Record<string, string[]> = {
  "Central Province": ["Kandy", "Matale", "Nuwara Eliya"],
  "Eastern Province": ["Ampara", "Batticaloa", "Trincomalee"],
  "North Central Province": ["Anuradhapura", "Polonnaruwa"],
  "Northern Province": [
    "Jaffna",
    "Kilinochchi",
    "Mannar",
    "Mullaitivu",
    "Vavuniya",
  ],
  "North Western Province": ["Kurunegala", "Puttalam"],
  "Sabaragamuwa Province": ["Kegalle", "Ratnapura"],
  "Southern Province": ["Galle", "Hambantota", "Matara"],
  "Uva Province": ["Badulla", "Monaragala"],
  "Western Province": ["Colombo", "Gampaha", "Kalutara"],
};

export const DATE_FORMAT_OPTIONS: ChoiceOption[] = [
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY" },
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD" },
];

export function countryDefaults(countryCode?: string): CountryChoice {
  return (
    COUNTRY_OPTIONS.find((country) => country.value === countryCode) ??
    COUNTRY_OPTIONS[0]
  );
}

export function districtsForProvince(province?: string): ChoiceOption[] {
  const districts = province ? (DISTRICTS_BY_PROVINCE[province] ?? []) : [];
  return districts.map((value) => ({ value, label: value }));
}

export function optionLabel(options: ChoiceOption[], value?: string): string {
  return (
    options.find((option) => option.value === value)?.label ?? value ?? "—"
  );
}
