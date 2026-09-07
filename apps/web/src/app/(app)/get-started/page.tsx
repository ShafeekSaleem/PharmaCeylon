"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconCheck,
  IconCheckCircle,
  IconChevronRight,
  IconGrid,
  IconHome,
  IconPackage,
  IconSettings,
  IconShoppingCart,
  IconUpload,
  IconUserPlus,
} from "@/components/icons";
import { StatusStrip } from "@/components/ui";
import {
  confirmSetupTask,
  completeSetupJourney,
  fetchSetupReadiness,
  notifySetupJourneyChanged,
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
  const router = useRouter();
  const { userRoles } = useRoleAccess();
  const [data, setData] = useState<SetupReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

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

  useEffect(() => {
    if (data && !data.journeyEnabled) router.replace("/dashboard");
  }, [data, router]);

  const nextTask = useMemo(
    () => data?.tasks.find((task) => task.key === data.nextTask) ?? null,
    [data],
  );
  const nextStepNumber = useMemo(
    () =>
      data && nextTask
        ? data.tasks.findIndex((task) => task.key === nextTask.key) + 1
        : (data?.totalCount ?? 0),
    [data, nextTask],
  );

  async function confirm(
    task: "sales_settings" | "opening_inventory" | "checkout",
  ) {
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

  async function finishSetup() {
    setFinishing(true);
    setError(null);
    try {
      const result = await completeSetupJourney();
      notifySetupJourneyChanged();
      router.replace(result.nextPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to finish setup");
      setFinishing(false);
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
    return <div className={css.loading}>Opening your dashboard…</div>;
  }

  return (
    <div className={css.page}>
      <StatusStrip
        label="Workspace created"
        emphasis={data.tenant.name}
        actions={
          <Link href="/settings/tenant-profile">
            View business details <IconChevronRight size={15} />
          </Link>
        }
      />

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
              // Steps completed by an explicit decision rather than by something happening.
              // Opening stock joined them: an import posts the units, a person confirms the
              // figures match the shelves.
              const explicit =
                task.key === "sales_settings" ||
                task.key === "checkout" ||
                (task.key === "opening_inventory" && Boolean(task.facts));
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
                    {/* The values behind the decision. Without these, "Confirm" was a button
                        that asked you to agree to something you were never shown. */}
                    {!task.complete && task.facts && task.facts.length > 0 && (
                      <ul className={css.taskFacts}>
                        {task.facts.map((fact) => (
                          <li
                            key={fact.label}
                            className={
                              fact.ok === false ? css.taskFactWarn : undefined
                            }
                          >
                            <span>{fact.label}</span>
                            <strong>{fact.value}</strong>
                          </li>
                        ))}
                      </ul>
                    )}
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
                            ? "Open the till"
                            : task.key === "opening_inventory"
                              ? "View batches"
                              : "Change settings"}
                        </Link>
                        <button
                          type="button"
                          className={css.primarySmall}
                          disabled={confirming === task.key}
                          onClick={() =>
                            void confirm(
                              task.key as
                                | "sales_settings"
                                | "opening_inventory"
                                | "checkout",
                            )
                          }
                        >
                          {confirming === task.key
                            ? "Saving…"
                            : task.key === "opening_inventory"
                              ? "These are correct"
                              : task.key === "checkout"
                                ? "Ready to sell"
                                : "Looks right"}
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
            <div
              className={`${css.nextVisual}${nextTask ? "" : ` ${css.nextVisualDone}`}`}
            >
              <span>
                {nextTask ? (
                  TASK_ICONS[nextTask.key]
                ) : (
                  <IconCheckCircle size={29} />
                )}
              </span>
              <h2>{nextTask?.title ?? "Setup complete"}</h2>
              <p>
                {/* The task list itself is now mode-aware server-side, so this no longer
                    patches over a generic description with a special case. */}
                {nextTask
                  ? nextTask.description
                  : "Your first branch is ready to serve customers."}
              </p>
              {nextTask &&
              !["sales_settings", "checkout"].includes(nextTask.key) ? (
                <Link href={nextTask.href} className={css.secondaryButton}>
                  Continue setup
                </Link>
              ) : null}
              {!nextTask && data.readyForSales ? (
                <button
                  type="button"
                  className={css.finishButton}
                  disabled={finishing}
                  onClick={() => void finishSetup()}
                >
                  {finishing ? "Finishing setup…" : "Finish setup and go to dashboard"}
                  {!finishing ? <IconChevronRight size={16} /> : null}
                </button>
              ) : null}
            </div>
            <small>
              {data.readyForSales
                ? "You can return to Settings whenever your business changes."
                : "Reference catalog items do not add branch stock."}
            </small>
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
            {!data.optional.logoAdded ? (
              <Link href="/settings/tenant-profile">
                <span className={css.optionalIcon}>
                  <IconUpload size={21} />
                </span>
                <p>
                  <strong>Add your logo</strong>
                  <small>Brand invoices and receipts.</small>
                </p>
                <em>Upload</em>
                <IconChevronRight size={15} />
              </Link>
            ) : null}
            {data.optional.catalogCoverage.ranged > 0 ? (
              <Link href="/products/manage?view=needs_category">
                <span className={css.optionalIcon}>
                  <IconGrid size={21} />
                </span>
                <p>
                  <strong>Organize your catalog</strong>
                  <small>
                    {data.optional.catalogOrganized
                      ? "Everything you sell is filed under a category."
                      : `${data.optional.catalogCoverage.unplaced.toLocaleString()} of ${data.optional.catalogCoverage.ranged.toLocaleString()} products still need a category.`}
                  </small>
                </p>
                <em>
                  {data.optional.catalogOrganized
                    ? "Done"
                    : `${data.optional.catalogCoverage.percent}%`}
                </em>
                <IconChevronRight size={15} />
              </Link>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}
