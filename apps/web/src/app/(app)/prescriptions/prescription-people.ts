/**
 * Who typed a prescription in, and which pharmacist verified it (P1 #47). Registers and inspectors
 * care about the second: the pharmacist whose SLMC registration the counter checked when it was
 * recorded, either a PIN co-signer or a registered pharmacist recording it alone.
 */
export type PrescriptionPeople = {
  recordedBy: { id: string; fullName: string };
  /** Null when it was recorded on the web, where no registration is checked. */
  checkedBy: { id: string; fullName: string; slmcNumber: string } | null;
};

/** The "Pharmacist checked by" value, as name and a second line. */
export function checkedByLabel(checkedBy: PrescriptionPeople["checkedBy"]) {
  return checkedBy
    ? { name: checkedBy.fullName, detail: `SLMC ${checkedBy.slmcNumber}` }
    : { name: "Not checked", detail: "Recorded on the web, with no registration check" };
}
