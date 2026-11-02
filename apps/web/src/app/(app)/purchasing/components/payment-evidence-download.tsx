"use client";
import { useRef, useState } from "react";
import { useAuth } from "@/lib/use-auth";
import { apiFetch } from "@/lib/auth-client";
import { parseApiError } from "@/lib/api-error";
import { ModalButton } from "@/components/ui";

export function PaymentEvidenceDownload({
  evidence,
}: {
  evidence: { id: string; mediaType: string };
}) {
  const { branchId, user } = useAuth();
  const identity = `${user?.tenantId}:${user?.id}:${branchId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/purchasing/payment-evidence/${evidence.id}`,
        { cache: "no-store" },
      );
      if (!response.ok)
        throw new Error(
          parseApiError(
            await response.text(),
            "Unable to download the supporting document",
          ),
        );
      const blob = await response.blob();
      if (currentIdentity.current !== identity) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const extension =
        (
          {
            "application/pdf": "pdf",
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
          } as Record<string, string>
        )[evidence.mediaType] || "bin";
      link.download = `payment-evidence-${evidence.id}.${extension}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (currentIdentity.current !== identity) return;
      setError(
        err instanceof Error ? err.message : "Unable to download document",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <ModalButton disabled={busy} onClick={() => void download()}>
        Download evidence
      </ModalButton>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
