"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { IconFirstAid } from "@/components/icons";
import { fetchOnboardingDraft } from "@/lib/onboarding-draft-client";
import styles from "./onboarding.module.css";

export default function OnboardingPage() {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    void fetchOnboardingDraft()
      .then((result) => router.replace(result.nextPath))
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Unable to resume setup",
        ),
      );
  }, [router]);

  return (
    <main className={styles.loading}>
      <span className={styles.loadingMark}>
        <IconFirstAid size={24} />
      </span>
      <b>{error || "Resuming your workspace setup…"}</b>
    </main>
  );
}
