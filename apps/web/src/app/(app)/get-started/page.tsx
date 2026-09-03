"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconCheck,
  IconCheckCircle,
  IconChevronRight,
  IconHome,
  IconPackage,
  IconSettings,
  IconShoppingCart,
  IconUpload,
  IconUserPlus,
} from "@/components/icons";
import {
  confirmSetupTask,
  fetchSetupReadiness,
  type ReadinessTaskKey,
  type SetupReadiness,
} from "@/lib/setup-readiness-client";
import { useRoleAccess } from "@/lib/use-role-access";
import css from "./get-started.module.css";

const TASK_ICONS: Record<ReadinessTaskKey, ReactNode> = {
  business_branch: <IconHome size={21} />,
  products: <IconPackage size={21} />,
  opening_inventory: <IconUpload size={21} />,
  sales_settings: <IconSettings size={21} />,
  checkout: <IconShoppingCart size={21} />,
};

export default function GetStartedPage() {
  const { userRoles } = useRoleAccess();
  const [data, setData] = useState<SetupReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = () => {
    setError(null);
    void fetchSetupReadiness()
      .then(setData)
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to load setup progress",
        ),
      );
  };

  useEffect(load, []);

  const nextTask = useMemo(
    () => data?.tasks.find((task) => task.key === data.nextTask) ?? null,
    [data],
  );
  const nextStepNumber = useMemo(
    () =>
      data && nextTask
        ? data.tasks.findIndex((task) => task.key === nextTask.key) + 1
        : data?.totalCount ?? 0,
    [data, nextTask],
  );

  async function confirm(task: "sales_settings" | "checkout") {
    setConfirming(task);
    setError(null);
    try {
      setData(await confirmSetupTask(task));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to confirm this step",
      );
    } finally {
      setConfirming(null);
    }
  }

  if (!userRoles.includes("owner")) {
    return (
      <Alert variant="error">
        The setup journey is available to workspace owners only.
      </Alert>
    );
  }
  if (!data && !error)
    return <div className={css.loading}>Loading your setup journey…</div>;
  if (!data) return <Alert variant="error">{error}</Alert>;
  if (!data.journeyEnabled) {
    return (
      <div className={css.notApplicable}>
        <span><IconCheckCircle size={28} /></span>
        <h1>This workspace is already established</h1>
        <p>The guided first-branch setup is only used for newly created pharmacy workspaces.</p>
        <Link href="/dashboard" className={css.secondaryButton}>Go to dashboard</Link>
      </div>
    );
  }

  return (
    <div className={css.page}>
      <section className={css.workspaceBanner}>
        <span>
          <IconCheck size={17} />
        </span>
        <p>
          Workspace created <i>·</i> <strong>{data.tenant.name}</strong>
        </p>
        <Link href="/settings/tenant-profile">
          View business details <IconChevronRight size={15} />
        </Link>
      </section>

      <header className={css.hero}>
        <div>
          <p className={css.eyebrow}>FIRST-BRANCH SETUP</p>
          <h1>
            {data.readyForSales
              ? `${data.branch.name} is ready for sales`
              : `Let’s get ${data.branch.name} ready for its first sale`}
          </h1>
          <p>
            {data.readyForSales
              ? "Your required setup is complete. You can keep refining settings at any time."
              : "Complete the essentials below. You can explore your workspace anytime."}
          </p>
        </div>
        <Link href="/dashboard" className={css.secondaryButton}>
          Explore dashboard
        </Link>
      </header>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className={css.layout}>
        <section className={css.checklistCard}>
          <div className={css.progressHeader}>
            <div>
              <h2>Branch setup</h2>
              <span>
                {data.completedCount} of {data.totalCount} essentials complete
              </span>
            </div>
            <strong>{data.percent}%</strong>
          </div>
          <div
            className={css.progressTrack}
            aria-label={`${data.percent}% complete`}
          >
            <i style={{ width: `${data.percent}%` }} />
          </div>

          <ol className={css.tasks}>
            {data.tasks.map((task, index) => {
              const explicit =
                task.key === "sales_settings" || task.key === "checkout";
              return (
                <li
                  key={task.key}
                  className={`${task.complete ? css.taskComplete : ""} ${task.key === data.nextTask ? css.taskNext : ""}`}
                >
                  <span className={css.taskNumber}>
                    {task.complete ? <IconCheck size={16} /> : index + 1}
                  </span>
                  <span className={css.taskIcon}>{TASK_ICONS[task.key]}</span>
                  <div className={css.taskCopy}>
                    <strong>{task.title}</strong>
                    <p>{task.description}</p>
                  </div>
                  <div className={css.taskActions}>
                    {task.complete ? (
                      <span className={css.completeBadge}>Complete</span>
                    ) : !task.available ? (
                      <span className={css.pendingBadge}>
                        After previous step
                      </span>
                    ) : explicit ? (
                      <>
                        <Link href={task.href} className={css.textLink}>
                          {task.key === "checkout"
                            ? "Open POS"
                            : "Review settings"}
                        </Link>
                        <button
                          type="button"
                          className={css.primarySmall}
                          disabled={confirming === task.key}
                          onClick={() =>
                            void confirm(task.key as "sales_settings" | "checkout")
                          }
                        >
                          {confirming === task.key ? "Saving…" : "Confirm"}
                        </button>
                      </>
                    ) : (
                      <Link href={task.href} className={css.primarySmall}>
                        {task.key === "products"
                          ? "Set up products"
                          : "Continue"}
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          <footer
            className={data.readyForSales ? css.readyFooter : css.blockedFooter}
          >
            {data.readyForSales ? (
              <IconCheckCircle size={20} />
            ) : (
              <IconAlertTriangle size={20} />
            )}
            <div>
              <strong>
                {data.readyForSales
                  ? "Ready for real sales"
                  : "Not ready for real sales"}
              </strong>
              <span>
                {data.readyForSales
                  ? "All required checks for this branch are complete."
                  : "Finish the required setup for this branch before checkout."}
              </span>
            </div>
          </footer>
        </section>

        <aside className={css.sideColumn}>
          <section className={css.nextCard}>
            <div className={css.cardHeading}>
              <p>YOUR NEXT STEP</p>
              <span>
                {nextStepNumber}/{data.totalCount}
              </span>
            </div>
            <div className={css.nextVisual}>
              <span>
                {nextTask ? (
                  TASK_ICONS[nextTask.key]
                ) : (
                  <IconCheckCircle size={29} />
                )}
              </span>
              <h2>{nextTask?.title ?? "Setup complete"}</h2>
              <p>
                {nextTask
                  ? data.branch.setupMode === "migrating" &&
                    nextTask.key === "products"
                    ? "Moving from another system? Start by bringing in your product list."
                    : nextTask.description
                  : "Your first branch is ready to serve customers."}
              </p>
              {nextTask &&
              !["sales_settings", "checkout"].includes(nextTask.key) ? (
                <Link href={nextTask.href} className={css.secondaryButton}>
                  Continue setup
                </Link>
              ) : null}
            </div>
            <small>Reference catalog items do not add branch stock.</small>
          </section>

          <section className={css.optionalCard}>
            <div className={css.cardHeading}>
              <p>MAKE IT YOURS</p>
              <span>Optional</span>
            </div>
            <Link href="/users">
              <span className={css.optionalIcon}>
                <IconUserPlus size={21} />
              </span>
              <p>
                <strong>Invite your team</strong>
                <small>Add members and set roles.</small>
              </p>
              <em>{data.optional.teamInvited ? "Done" : "Invite"}</em>
              <IconChevronRight size={15} />
            </Link>
            <Link href="/settings/tenant-profile">
              <span className={css.optionalIcon}>
                <IconUpload size={21} />
              </span>
              <p>
                <strong>Add your logo</strong>
                <small>Brand invoices and receipts.</small>
              </p>
              <em>{data.optional.logoAdded ? "Done" : "Upload"}</em>
              <IconChevronRight size={15} />
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
