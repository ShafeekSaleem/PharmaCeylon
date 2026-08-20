/**
 * Tier 1 of the commercial-medicine-classification design (see root CLAUDE.md): deterministic
 * generic-name / dosage-form keyword rules. Runs only against products whose primary COMMERCIAL
 * category is still the "Unclassified Medicines" safety net (`assignmentSource: SYSTEM_DEFAULT`)
 * — it never touches a MANUAL or previously AUTO_CLASSIFIED assignment. Anything that doesn't
 * match a rule stays in Unclassified Medicines for human review, rather than guessing.
 *
 * This is intentionally simple substring matching on well-known INN/generic names — good enough
 * to sort a real NMRA catalog into sensible departments for merchandising/reporting, not a
 * clinical classification system. Tiers 2 (known-mapping table) and 3 (AI suggestion + human
 * review queue) described in the architecture doc are follow-up work.
 */

export type MedicineClassificationRule = {
  canonicalKey: string;
  /** Matched case-insensitively against genericName (preferred) then name as a fallback. */
  keywords: string[];
};

export const MEDICINE_CLASSIFICATION_RULES: MedicineClassificationRule[] = [
  {
    canonicalKey: "MEDICINES_DIABETES_CARE",
    keywords: [
      "METFORMIN", "GLICLAZIDE", "GLIMEPIRIDE", "GLIBENCLAMIDE", "GLIPIZIDE",
      "SITAGLIPTIN", "VILDAGLIPTIN", "LINAGLIPTIN", "SAXAGLIPTIN", "ALOGLIPTIN",
      "EMPAGLIFLOZIN", "DAPAGLIFLOZIN", "CANAGLIFLOZIN", "PIOGLITAZONE",
      "ACARBOSE", "REPAGLINIDE", "INSULIN", "LIRAGLUTIDE", "SEMAGLUTIDE",
    ],
  },
  {
    canonicalKey: "MEDICINES_CARDIOVASCULAR",
    keywords: [
      "ATORVASTATIN", "ROSUVASTATIN", "SIMVASTATIN", "PRAVASTATIN",
      "LOSARTAN", "TELMISARTAN", "VALSARTAN", "OLMESARTAN", "IRBESARTAN", "CANDESARTAN",
      "AMLODIPINE", "NIFEDIPINE", "FELODIPINE", "DILTIAZEM", "VERAPAMIL",
      "ENALAPRIL", "LISINOPRIL", "RAMIPRIL", "PERINDOPRIL", "CAPTOPRIL",
      "BISOPROLOL", "METOPROLOL", "ATENOLOL", "CARVEDILOL", "PROPRANOLOL", "NEBIVOLOL",
      "CLOPIDOGREL", "WARFARIN", "RIVAROXABAN", "APIXABAN", "DABIGATRAN",
      "DIGOXIN", "FUROSEMIDE", "SPIRONOLACTONE", "HYDROCHLOROTHIAZIDE", "INDAPAMIDE",
      "ISOSORBIDE", "GLYCERYL TRINITRATE", "NITROGLYCERIN", "IVABRADINE", "DIPYRIDAMOLE",
    ],
  },
  {
    canonicalKey: "MEDICINES_ANTI_INFECTIVES",
    keywords: [
      "AMOXICILLIN", "AZITHROMYCIN", "CIPROFLOXACIN", "LEVOFLOXACIN", "MOXIFLOXACIN", "OFLOXACIN",
      "CEFUROXIME", "CEFIXIME", "CEFPODOXIME", "CEFADROXIL", "CEFTRIAXONE", "CEFALEXIN", "CEPHALEXIN",
      "FLUCLOXACILLIN", "CLOXACILLIN", "AMPICILLIN", "PENICILLIN",
      "CLARITHROMYCIN", "ERYTHROMYCIN", "DOXYCYCLINE", "TETRACYCLINE", "MINOCYCLINE",
      "METRONIDAZOLE", "TINIDAZOLE", "CLINDAMYCIN", "COTRIMOXAZOLE", "SULFAMETHOXAZOLE",
      "ITRACONAZOLE", "FLUCONAZOLE", "KETOCONAZOLE", "TERBINAFINE", "GRISEOFULVIN",
      "ACYCLOVIR", "ACICLOVIR", "VALACYCLOVIR", "OSELTAMIVIR", "AMPHOTERICIN",
      "ALBENDAZOLE", "MEBENDAZOLE", "IVERMECTIN", "PRAZIQUANTEL",
      "RIFAMPICIN", "ISONIAZID", "ETHAMBUTOL", "PYRAZINAMIDE",
      "AMOXICILLIN AND CLAVULANATE", "AMOXICILLIN/CLAVULANATE", "CEFOTAXIME", "CEFEPIME",
    ],
  },
  {
    canonicalKey: "MEDICINES_DIGESTIVE_HEALTH",
    keywords: [
      "OMEPRAZOLE", "ESOMEPRAZOLE", "PANTOPRAZOLE", "RABEPRAZOLE", "LANSOPRAZOLE",
      "DOMPERIDONE", "RANITIDINE", "FAMOTIDINE", "METOCLOPRAMIDE", "ONDANSETRON",
      "LOPERAMIDE", "LACTULOSE", "MEBEVERINE", "HYOSCINE", "SUCRALFATE",
      "SIMETHICONE", "DICYCLOMINE", "BISACODYL", "ORS", "ORAL REHYDRATION",
      "PROBIOTIC", "SENNA",
    ],
  },
  {
    canonicalKey: "MEDICINES_COLD_COUGH_ALLERGY",
    keywords: [
      "CETIRIZINE", "LORATADINE", "FEXOFENADINE", "DESLORATADINE", "LEVOCETIRIZINE",
      "CHLORPHENIRAMINE", "PROMETHAZINE", "DIPHENHYDRAMINE", "HYDROXYZINE",
      "DEXTROMETHORPHAN", "BROMHEXINE", "GUAIFENESIN", "AMBROXOL", "CARBOCISTEINE",
      "PSEUDOEPHEDRINE", "PHENYLEPHRINE", "OXYMETAZOLINE", "XYLOMETAZOLINE",
    ],
  },
  {
    canonicalKey: "MEDICINES_RESPIRATORY",
    keywords: [
      "SALBUTAMOL", "ALBUTEROL", "BUDESONIDE", "FORMOTEROL", "SALMETEROL",
      "MONTELUKAST", "THEOPHYLLINE", "IPRATROPIUM", "TIOTROPIUM", "BECLOMETHASONE",
      "FLUTICASONE", "TERBUTALINE",
    ],
  },
  {
    canonicalKey: "MEDICINES_PAIN_FEVER",
    keywords: [
      "PARACETAMOL", "ACETAMINOPHEN", "IBUPROFEN", "DICLOFENAC", "ACECLOFENAC",
      "MEFENAMIC ACID", "ETORICOXIB", "CELECOXIB", "NAPROXEN", "KETOROLAC",
      "INDOMETHACIN", "TRAMADOL", "NIMESULIDE", "PIROXICAM", "FLURBIPROFEN",
      "MELOXICAM", "ASPIRIN", "ACETYLSALICYLIC",
    ],
  },
  {
    canonicalKey: "MEDICINES_WOMENS_HEALTH",
    keywords: [
      "FOLIC ACID", "FERROUS", "IRON", "ETHINYLESTRADIOL", "LEVONORGESTREL",
      "NORETHISTERONE", "CLOMIPHENE", "MIFEPRISTONE", "MISOPROSTOL",
      "ESTRADIOL", "PROGESTERONE", "OXYTOCIN", "CARBETOCIN",
    ],
  },
  {
    canonicalKey: "MEDICINES_MENS_HEALTH",
    keywords: ["TADALAFIL", "SILDENAFIL", "FINASTERIDE", "TAMSULOSIN", "DUTASTERIDE"],
  },
  {
    canonicalKey: "MEDICINES_DERMATOLOGY",
    keywords: [
      "CLOTRIMAZOLE", "FUSIDIC ACID", "BETAMETHASONE", "MUPIROCIN", "HYDROCORTISONE",
      "MICONAZOLE", "PERMETHRIN", "CALAMINE", "SALICYLIC ACID", "BENZOYL PEROXIDE",
      "ADAPALENE", "TRETINOIN", "TERBINAFINE CREAM",
    ],
  },
  {
    // Recognized therapeutic classes with no dedicated department in the standard template
    // (neurology/psychiatry, oncology, systemic steroids, anaesthetics/IV fluids). Landing
    // these in "Other Medicines" is a merchandising label only — low-risk and reversible via
    // Settings → Catalog → Categories — unlike genuinely unrecognized generic names, which
    // stay in Unclassified Medicines for human review.
    canonicalKey: "MEDICINES_OTHER",
    keywords: [
      "PREGABALIN", "GABAPENTIN", "LEVETIRACETAM", "CLOBAZAM", "CARBAMAZEPINE",
      "SODIUM VALPROATE", "VALPROIC ACID", "LAMOTRIGINE", "PHENYTOIN", "TOPIRAMATE",
      "ESCITALOPRAM", "SERTRALINE", "PAROXETINE", "FLUOXETINE", "DULOXETINE",
      "RISPERIDONE", "HALOPERIDOL", "OLANZAPINE", "QUETIAPINE", "ARIPIPRAZOLE",
      "DIAZEPAM", "ALPRAZOLAM", "LORAZEPAM", "CLONAZEPAM",
      "CISPLATIN", "CARBOPLATIN", "TEMOZOLOMIDE", "DOXORUBICIN", "CYCLOPHOSPHAMIDE",
      "IMATINIB", "BORTEZOMIB", "METHOTREXATE", "TAMOXIFEN", "LETROZOLE",
      "PREDNISOLONE", "METHYLPREDNISOLONE", "DEXAMETHASONE", "HYDROCORTISONE INJECTION",
      "LIDOCAINE", "BUPIVACAINE", "SODIUM CHLORIDE", "DEXTROSE", "AMINOPHYLLINE",
      "PNEUMOCOCCAL", "TETANUS", "HEPATITIS B VACCINE", "RABIES",
    ],
  },
];

/** Dosage-form hints applied after (and only if) no genericName/name keyword matched. */
const DOSAGE_FORM_RULES: Array<{ canonicalKey: string; patterns: RegExp[] }> = [
  { canonicalKey: "MEDICINES_EYE_EAR", patterns: [/EYE/, /OPHTHALMIC/, /\bOTIC\b/, /\bEAR\b/] },
  { canonicalKey: "MEDICINES_DERMATOLOGY", patterns: [/\bCREAM\b/, /\bOINTMENT\b/, /\bGEL\b/, /\bLOTION\b/] },
  { canonicalKey: "MEDICINES_RESPIRATORY", patterns: [/INHAL/, /NASAL SPRAY/] },
];

function matchesKeyword(haystack: string, keyword: string): boolean {
  return haystack.includes(keyword);
}

/**
 * Best-effort commercial category for an NMRA medicine, or null if nothing matched (caller
 * should leave the product in Unclassified Medicines rather than guessing).
 */
export function classifyMedicine(
  genericName: string | null,
  name: string | null,
  dosageForm: string | null,
): { canonicalKey: string; confidence: number } | null {
  const generic = (genericName ?? "").toUpperCase();
  const productName = (name ?? "").toUpperCase();

  for (const rule of MEDICINE_CLASSIFICATION_RULES) {
    for (const keyword of rule.keywords) {
      if (matchesKeyword(generic, keyword)) {
        return { canonicalKey: rule.canonicalKey, confidence: 0.85 };
      }
    }
  }
  // Weaker signal — match against the display name instead of the (missing/odd) generic name.
  for (const rule of MEDICINE_CLASSIFICATION_RULES) {
    for (const keyword of rule.keywords) {
      if (matchesKeyword(productName, keyword)) {
        return { canonicalKey: rule.canonicalKey, confidence: 0.6 };
      }
    }
  }

  const form = (dosageForm ?? "").toUpperCase();
  for (const rule of DOSAGE_FORM_RULES) {
    if (rule.patterns.some((p) => p.test(form))) {
      return { canonicalKey: rule.canonicalKey, confidence: 0.5 };
    }
  }

  return null;
}
