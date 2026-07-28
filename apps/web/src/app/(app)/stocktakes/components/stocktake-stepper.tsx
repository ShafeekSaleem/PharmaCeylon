"use client";

import type { StocktakeListItem, StocktakeStatus } from "../types";
import { formatDate } from "../utils";
import scss from "../stocktakes.module.css";

type StepKey = "created" | "counting" | "submitted" | "review" | "posted" | "completed";

const STEPS: Array<{ key: StepKey; label: string }> = [
  { key: "created", label: "Created" },
  { key: "counting", label: "Counting" },
  { key: "submitted", label: "Submitted" },
  { key: "review", label: "Review" },
  { key: "posted", label: "Posted" },
  { key: "completed", label: "Completed" },
];

function currentStepIndex(status: StocktakeStatus): number {
  switch (status) {
    case "draft":
    case "scheduled":
      return 0;
    case "counting":
      return 1;
    case "submitted":
      return 2;
    case "under_review":
    case "approved":
      return 3;
    case "posted":
      return 4;
    case "completed":
      return 5;
    default:
      return 0;
  }
}

function stepMeta(key: StepKey, stocktake: StocktakeListItem, index: number, current: number): string {
  switch (key) {
    case "created":
      return formatDate(stocktake.createdAt);
    case "counting":
      if (stocktake.startedAt) return index === current ? "In progress" : formatDate(stocktake.startedAt);
      return index === current ? "In progress" : "";
    case "submitted":
      if (stocktake.submittedAt) return formatDate(stocktake.submittedAt);
      return index === current ? "In progress" : "";
    case "review":
      if (stocktake.status === "approved") return "Approved";
      if (stocktake.reviewStartedAt) return formatDate(stocktake.reviewStartedAt);
      return index === current ? "In progress" : "";
    case "posted":
      if (stocktake.postedAt) return formatDate(stocktake.postedAt);
      return index === current ? "Ready to post" : "";
    case "completed":
      if (stocktake.completedAt) return formatDate(stocktake.completedAt);
      return index === current ? "Ready to complete" : "";
    default:
      return "";
  }
}

type Props = { stocktake: StocktakeListItem };

export function StocktakeStepper({ stocktake }: Props) {
  if (stocktake.status === "cancelled") {
    return <div className={scss.stepperCancelled}>Stocktake cancelled — workflow halted.</div>;
  }

  const current = currentStepIndex(stocktake.status);

  return (
    <div className={scss.stepper} role="list" aria-label="Stocktake status timeline">
      {STEPS.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const meta = stepMeta(step.key, stocktake, index, current);
        return (
          <div key={step.key} className={scss.stepItem} role="listitem" aria-current={active ? "step" : undefined}>
            <div className={scss.stepDotRow}>
              <span
                className={`${scss.stepConnector}${index <= current ? ` ${scss.stepConnectorDone}` : ""}`}
              />
              <span
                className={`${scss.stepDot}${done ? ` ${scss.stepDotDone}` : ""}${
                  active ? ` ${scss.stepDotActive}` : ""
                }`}
              >
                {done ? "✓" : index + 1}
              </span>
              <span
                className={`${scss.stepConnector}${index < current ? ` ${scss.stepConnectorDone}` : ""}`}
              />
            </div>
            <span className={`${scss.stepLabel}${!done && !active ? ` ${scss.stepLabelPending}` : ""}`}>
              {step.label}
            </span>
            {meta ? <span className={scss.stepMeta}>{meta}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
