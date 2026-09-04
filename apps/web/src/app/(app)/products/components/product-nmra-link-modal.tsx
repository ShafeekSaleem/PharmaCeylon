"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import {
  applyNmraLink,
  fetchNmraLinkCandidates,
  previewNmraLink,
  type NmraLinkCandidate,
  type NmraLinkEvidence,
  type NmraLinkFieldChange,
  type NmraLinkPreview,
} from "../api/nmra-link";
import css from "./product-nmra-link.module.css";

type Props = {
  open: boolean;
  productId: string;
  onClose: () => void;
  onLinked: () => void;
};

const EVIDENCE_LABELS: Record<NmraLinkEvidence, string> = {
  barcode: "Barcode",
  registration: "Registration no.",
  name: "Exact name",
  normalized: "Similar name",
  fuzzy: "Generic + strength + form",
  inn_head: "Substance name",
};

const STRONG_EVIDENCE: NmraLinkEvidence[] = ["barcode", "registration", "name"];

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  brandName: "Brand",
  barcode: "Barcode",
  genericName: "Generic name",
  dosageForm: "Dosage form",
  strength: "Strength",
  unit: "Unit",
  packSize: "Pack size",
  packType: "Pack type",
  manufacturer: "Manufacturer",
  localAgent: "Local agent",
  countryOfOrigin: "Country of origin",
  storage: "Storage",
  shelfLife: "Shelf life",
  registrationNo: "Registration no.",
  registrationDate: "Registration date",
  schedule: "Schedule",
  regType: "Registration type",
  dossierNo: "Dossier no.",
  isControlled: "Controlled medicine",
  requiresPrescription: "Requires prescription",
};

function formatValue(value: string | boolean | null): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value;
}

/**
 * Find a match, see exactly what would change, confirm. Candidates are ranked, not a unique
 * pick — twenty registered paracetamols is the normal case, and the right brand is a
 * judgement call the pharmacist makes here, not something the matcher should guess.
 */
export function ProductNmraLinkModal({ open, productId, onClose, onLinked }: Props) {
  const [step, setStep] = useState<"candidates" | "preview">("candidates");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<NmraLinkCandidate[]>([]);
  const [selected, setSelected] = useState<NmraLinkCandidate | null>(null);
  const [preview, setPreview] = useState<NmraLinkPreview | null>(null);
  const [overrides, setOverrides] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const loadCandidates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchNmraLinkCandidates(productId);
      setCandidates(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load candidates");
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    if (!open) return;
    setStep("candidates");
    setSelected(null);
    setPreview(null);
    setOverrides(new Set());
    void loadCandidates();
  }, [open, loadCandidates]);

  async function loadPreview(referenceId: string, adopt: Set<string>) {
    setLoading(true);
    setError(null);
    try {
      const result = await previewNmraLink(productId, referenceId, [...adopt]);
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't build a preview");
    } finally {
      setLoading(false);
    }
  }

  function selectCandidate(candidate: NmraLinkCandidate) {
    setSelected(candidate);
    setStep("preview");
    void loadPreview(candidate.product.id, overrides);
  }

  function toggleOverride(field: string) {
    const next = new Set(overrides);
    if (next.has(field)) next.delete(field);
    else next.add(field);
    setOverrides(next);
    if (selected) void loadPreview(selected.product.id, next);
  }

  async function confirmLink() {
    if (!selected) return;
    setApplying(true);
    setError(null);
    try {
      await applyNmraLink(productId, selected.product.id, [...overrides]);
      onLinked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply this link");
    } finally {
      setApplying(false);
    }
  }

  const changedFields = preview?.plan.changes.filter((c) => c.changed) ?? [];
  const adoptableUnchanged =
    preview?.plan.changes.filter((c) => c.adoptable && !c.changed) ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={step === "candidates" ? "Find a register match" : "Review the link"}
      description={
        step === "candidates"
          ? "Ranked by how strong the evidence is. Pick the right brand — a wrong pick would set the wrong registration and compliance flags."
          : undefined
      }
      size="lg"
      footer={
        step === "preview" ? (
          <ModalFooter>
            <ModalButton onClick={() => setStep("candidates")} disabled={applying}>
              Back
            </ModalButton>
            <ModalButton variant="primary" loading={applying} onClick={() => void confirmLink()}>
              Link this product
            </ModalButton>
          </ModalFooter>
        ) : undefined
      }
    >
      {error && (
        <Alert variant="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {step === "candidates" && (
        <div className={css.stepBody}>
          {loading ? (
            <p>Loading candidates…</p>
          ) : candidates.length === 0 ? (
            <p>No register candidates found for this product.</p>
          ) : (
            <ul className={css.candidateList}>
              {candidates.map((c) => (
                <li key={c.product.id} className={css.candidateRow}>
                  <div className={css.candidateMain}>
                    <span className={css.candidateName}>
                      {c.product.name}
                      {c.product.brandName ? ` — ${c.product.brandName}` : ""}
                    </span>
                    <span className={css.candidateMeta}>
                      {[
                        c.product.genericName,
                        [c.product.strength, c.product.dosageForm].filter(Boolean).join(" · "),
                        c.product.registrationNo ? `Reg. ${c.product.registrationNo}` : null,
                      ]
                        .filter(Boolean)
                        .join(" — ")}
                    </span>
                    <span>
                      <span
                        className={`${css.evidenceChip}${
                          STRONG_EVIDENCE.includes(c.evidence) ? ` ${css.evidenceChipStrong}` : ""
                        }`}
                      >
                        {EVIDENCE_LABELS[c.evidence]}
                      </span>
                      {c.needsComplianceConfirmation && (
                        <span className={`${css.complianceChip} ${css.chipSpaced}`}>
                          Compliance change
                        </span>
                      )}
                    </span>
                  </div>
                  <ModalButton onClick={() => selectCandidate(c)}>Select</ModalButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {step === "preview" && (
        <div className={css.stepBody}>
          {loading || !preview ? (
            <p>Building preview…</p>
          ) : (
            <>
              {preview.plan.complianceStatements.length > 0 && (
                <Alert variant="warning">
                  {preview.plan.complianceStatements.map((s) => (
                    <div key={s}>{s}</div>
                  ))}
                </Alert>
              )}

              {changedFields.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table className={css.diffTable}>
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>From</th>
                        <th />
                        <th>To</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changedFields.map((c) => (
                        <tr key={c.field}>
                          <td className={css.diffFieldChanged}>{FIELD_LABELS[c.field] ?? c.field}</td>
                          <td className={css.diffFrom}>{formatValue(c.from)}</td>
                          <td className={css.diffArrow}>→</td>
                          <td>{formatValue(c.to)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {adoptableUnchanged.length > 0 && (
                <div>
                  <p className={css.candidateMeta}>
                    Already set on this product — kept by default. Adopt the register&apos;s value
                    instead:
                  </p>
                  <ul className={css.summaryList}>
                    {adoptableUnchanged.map((c: NmraLinkFieldChange) => (
                      <li key={c.field} className={css.diffAdoptToggle}>
                        <label>
                          <input
                            type="checkbox"
                            checked={overrides.has(c.field)}
                            onChange={() => toggleOverride(c.field)}
                          />{" "}
                          {FIELD_LABELS[c.field] ?? c.field}: keep &ldquo;{formatValue(c.from)}&rdquo;
                          instead of &ldquo;{formatValue(c.to)}&rdquo;
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <ul className={css.summaryList}>
                {preview.regulatoryCategories.length > 0 && (
                  <li>
                    Regulatory categories adopted: {preview.regulatoryCategories.map((r) => r.categoryName).join(", ")}
                  </li>
                )}
                {preview.commercialCategory && (
                  <li>
                    {preview.commercialCategory.willAdopt
                      ? `Commercial category set to "${preview.commercialCategory.categoryName}".`
                      : `Commercial category kept as-is (not "${preview.commercialCategory.categoryName}") — a deliberate choice is never overwritten.`}
                  </li>
                )}
                {preview.tagsToMerge.length > 0 && (
                  <li>Tags added: {preview.tagsToMerge.map((t) => t.name).join(", ")}</li>
                )}
                <li>
                  &ldquo;{selected?.product.name}&rdquo; stays searchable as an alias if it differs
                  from the register&apos;s name.
                </li>
              </ul>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
