# Dashboard daily-work implementation and review

Branch: `feat/dashboard-daily-work`, based on `develop` at `70681fe`.

## Daily workspace

A fixed daily-work area now precedes quick actions, KPIs, and the optional widget canvas. Each role has a short introduction and a useful primary action. The queue uses the active branch, even when an owner's analytical overview covers all branches; the branch name is shown beside the queue title.

The queue is a read model of existing operational records. It does not create a second completion or assignment system. Completing, cancelling, receiving, posting, or consuming the underlying record removes or advances its queue item on refresh.

Sources include purchase-order drafts/approvals/receiving, held delivery decisions, held write-off decisions, outgoing transfer approvals/dispatch, incoming transfer receiving, supplier returns, assigned stocktakes/review/posting/completion, the user's held bills, pharmacist-flagged holds for authorized approvers, and sellable stock approaching/past expiry. Quarantined stock and unconfirmed imported expiry placeholders do not generate expiry work.

Effective permissions determine sources and actions, including custom permission sets. Self-approval restrictions are reflected as “Another approver needed”; those records remain visible but are excluded from “Needs my decision”. Task counts are computed before pagination in the same SQL statement as the page. Filters are evaluated on the server. Pagination recovers automatically if completing work removes the last page.

“Assigned to me” reflects existing workflow ownership: stocktake assignments/reviewers, owned drafts/returns, and held bills. Shared receiving, dispatch, and stock-safety work is labelled by team rather than inventing an assignee. Date-only delivery/expiry deadlines remain inclusive in the branch timezone. A started stocktake does not become overdue simply because its scheduled start has passed when no completion deadline exists.

## Accuracy and workflow corrections

- Daily totals, unit counts, hourly charts, payment mix, product rankings, and staff totals use server aggregates; the recent-sales list is no longer used as a complete dataset. Cashier recent transactions are filtered by operator before the list limit is applied.
- Cashier-only users see their own sales for the branch business day. The schema has no shift entity, so the UI explicitly says “Your Sales Today”, not “Shift Sales”. Shared branch-held-bill and customer measures are labelled as branch measures.
- Charts include all 24 hours. Branch/tenant sales pulse day boundaries use business time rather than the API server's midnight.
- “Units sold” replaces unsupported dispensing claims. Hold age is a wait duration, never a clinical readiness state.
- Controlled-stock totals cover all matching products and deduplicate overlapping low/expiry signals rather than counting sliced previews.
- The owner's gross profit uses the actual last-30-days margin report and says so. Sales minus order value is no longer called profit; the tender chart is labelled Payment Mix. Recorded credit sales are not labelled an outstanding settled receivables balance.
- Sample insight filler and unsupported clinical widgets are excluded from the production dashboard catalog. Existing saved layouts filter out unsupported widgets.
- Queue and widget failures are visibly unavailable, distinct from zero activity. Stale request responses cannot overwrite a newer refresh. Explicit branch headers are preserved through request construction and retries.
- Visible dashboards refresh every minute and on returning to the tab. Self-fetching chart panels participate in dashboard refresh.

## UI review and fixes

The queue uses existing theme tokens, so the new area follows light/dark and accent settings. Primary task links open existing document workflows directly. No checkbox implies that a financial or stock operation can be completed from the dashboard.

The first review found oversized cashier chart slots, empty tablet columns, clipped mobile payment content, and repeated/unconnected clinical cards. These were corrected with compact defaults, explicit tablet/mobile packing, appropriate mobile payment-card height, and a smaller default widget selection. Saved desktop arrangements remain available.

Checks include desktop and phone layouts for owner, manager, pharmacist, cashier, and inventory clerk; filtering; unavailable queue/retry; theme rendering; and horizontal-overflow detection. Browser data is fixture-backed, not a live pharmacy account.

## Validation

- Web unit/component suites, including queue filters, request cancellation, stale response rejection, invalid-page recovery, failure/retry, deadline formatting, responsive packing, explicit branch headers, and chart failure/retry.
- API unit suites and TypeScript compilation, plus tenant-isolation and stock-write repository checks.
- API/shared and web production builds.
- New native PostgreSQL integration scenarios are in `apps/api/test/integration/dashboard.int-spec.ts` for the repository's existing integration runner.
- Independently executed the service SQL against PostgreSQL through PGlite using the generated real Prisma schema and seeded workflows: more than 50 sales, Colombo midnight, cashier and branch scopes, permission-restricted sources, assigned counts, self-approval, incoming/outgoing transfers, inclusive due dates, page counts, and workflow changes. This caught and corrected a cashier-only CTE column-alias issue.

A live PostgreSQL server was not available here, so the repository's native PostgreSQL integration runner and a deployed Nest/API-to-browser workflow smoke test remain staging checks. Fixture-backed browser tests and embedded PostgreSQL query tests do not establish deployed-system performance or concurrency behavior.

## Rollout

Run `npm run prisma:deploy -w api` before deploying. Migration `20261016000000_stage_held_approval_tenant_policies` completes the missing staged tenant policies for held deliveries and adjustments inherited from develop. It does not enable or force RLS. No new role permission or data backfill is needed. Deploy API and web together because the dashboard consumes the new `/dashboard/work`, `/dashboard/sales-metrics`, and `/dashboard/stock-metrics` endpoints.

For staging, use separate role accounts to check one real receiving, transfer, stocktake, held-delivery approval, write-off approval, and hold recall. Return to the dashboard and confirm that the corresponding task advances/disappears. Verify a non-self-approving role's own request remains blocked, and a branch switch cannot show the previous branch's work. Compare cashier daily totals with sales records at a branch exceeding 50 bills.

Shift sessions/till reconciliation and manually assigned recurring opening/closing routines remain separate product features. They are not represented as working capabilities by this dashboard.
