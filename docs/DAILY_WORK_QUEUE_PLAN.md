# Daily work: shared task discovery and module review

## Decision — 2026-11-09

Daily work is the cross-module place to discover, prioritize and follow tasks. Each business
module retains its document list, pending-approval/status views and specific review UI. There
is no separate refund-approvals destination, nor a separate approval inbox per workflow in the
sidebar. Notifications open the owning module with the exact document selected. Approval and
physical execution remain distinct operations.

Example: a cashier prepares an over-threshold refund → Daily work shows a decision to an
eligible manager → Sales → Pending approvals opens the exact refund → approval removes the
decision and produces counter work → a permitted staff member executes it at the correct till.
Transfer, stocktake, receiving, supplier-return and adjustment sources follow the same discovery
pattern, with their own review evidence and business rules.

## Current implementation versus planned work

Already available: a tenant/active-branch scoped `GET /dashboard/work` projection over multiple
workflow sources, typed task kinds, approval/blocked flags, categories, pagination, priority,
due dates, web/counter placement, filter counts and refresh timestamps. Notifications consume
the same model. Desktop Counter work lists physical operations; it is not a general management
inbox. Native mobile is currently an Expo placeholder without authentication or navigation.

This MR makes Sales' pending-refund view consume that common projection using `kind`, literal
`q` and bounded `pageSize`, and retains specialized refund detail/approval commands. It removes
the refund-only sidebar destination. A compatibility redirect preserves old draft-MR links.
These changes establish one queue source; they do not deliver the cross-app features below.

## Ownership and dependency boundaries

| Owner | Responsibility |
| --- | --- |
| W11 (new) | Shared task contract, source adapters, prioritization/assignment, cross-branch overview, app capability routing, queue consistency and task-specific acceptance |
| W9 #71 | Dashboard presentation, notification delivery/preferences and telemetry widgets; consumes W11 rather than building another task engine |
| W4 #66 | Sales/refund pending status, exact refund review, incident/payment recovery views |
| W5 #67 | Stocktake, transfer, receiving, supplier-return, adjustment and stock-case pending/status/review UI |
| P1 #47 | Live permissions, approval material/version evidence, actor audit and remote/local enforcement |
| P2 #48 / P2b #103 / P6 #52 | Desktop identity/shell, counter task presentation and physical workflow execution |
| P4 #50 / P5 #51 | Durable local work, accepted sync evidence, reconciliation/recovery and truthful freshness |
| W3 #65 | User/role eligibility and delegation; task assignment grants no new authority |
| W8 #70 | Onboarding readiness tasks supplied as explicit sources, without duplicate get-started state |
| W10 #72 / P7 #53 | Historical task/approval audit reporting and integrated device/pilot acceptance |

Existing domain delivery can continue. W11 does not block finished domain workflows or move their
approval/execution rules into a generic queue. Coordinate contract changes before adding new
app-specific task stores or navigation. W1/W7's closed foundations are reused, not reopened.

## Shared task model and source rules (W11 phase 1)

- Extend the existing shared `DailyWorkItem`/kind registry, rather than introduce another task
  table or parallel inbox API. Each source defines eligibility, stable identity, next action,
  document version, allowed app/place and completion condition. First extract common source
  interfaces from the current SQL union incrementally; retain transactional domain reads.
- Evolve fields additively: source module, entity type/id, branch, task stage, priority reason,
  due date/business timezone, actor/assignee/team, blocker reason, action capability and version,
  evidence freshness and document destination. Publish migration/compatibility fixtures for all
  clients before removing old `href`/`where` fields. No unversioned mobile/desktop URL assumptions.
- Separate lifecycle stages: needs preparation, pending decision, ready for local execution,
  blocked/recovery and completed/cancelled history. Domain status remains authoritative; tasks
  disappear/change when the real workflow changes. Notification read/dismiss, queue completion,
  assignment or snooze must never approve or execute a document.
- Required source inventory: purchase orders, prepared/held deliveries, held write-offs,
  adjustments, transfers (both branch legs), supplier returns, stocktakes/recounts, refunds,
  offline stock cases and supported incident/payment recovery. Add onboarding/device health
  sources only when authoritative data and an actionable destination exist. No placeholder
  telemetry or unsupported clinical actions.
- Enforce tenant and eligible branch/role scope before counts, search, sort or paging. Source
  filters only narrow access. Include self-approval blockers visibly in All/pending status;
  Needs my decision counts only actionable decisions. Revalidate everything at action time.
- Dashboard, module pending lists, desktop projections and notifications must share source
  inclusion predicates. Counts/list/source status must agree at a documented snapshot. Handle
  revoked/stale approval, threshold change, rejected/cancelled requests and partial execution.

## Owner/manager prioritization (W11 phase 2)

- Keep active-branch operations as the default. Add an explicitly selected My branches overview
  for eligible owners/managers, with per-branch counts and timezone-labelled deadlines. Read
  access is checked per branch; a multi-branch view is never permission to act at another branch.
- Offer All work, Needs my decision, Assigned to me/team, Overdue, Blocked and At the counter,
  with module, branch, task stage and urgency filters. Return counts and stable server pagination
  for the selected scope; preserve filters/deep links across navigation and branch switches.
- Publish deterministic sorting and visible reasons: safety/recovery blockers and customer-money
  risk first where supported, then explicit domain urgency/deadline and age, with a stable ID
  tie-break. Keep blocked work separate from executable work so a blocked task never prevents
  unrelated tasks being completed. No opaque AI priority or invented deadlines.
- Add permission-checked assignment/reassignment, reasoned priority overrides and acknowledgement
  only after actor/audit/concurrency rules are specified. Assignment coordinates work, never
  grants approval authority, bypasses self-approval or changes the document's requester.
- Define escalation/reminder and snooze policies with owners before shipping them. Critical
  evidence/recovery blocks cannot be hidden by snooze. Dedupe notifications by branch/task/stage;
  retire stale notifications when the authoritative task changes.

## App behavior (W11 phases 3–4)

| Surface | Discovery and review | Physical work / disconnected behavior |
| --- | --- | --- |
| Web | Cross-module Daily work, branch overview, module pending statuses and full document review/approval | Handoff to the enrolled branch counter; no generic execute button |
| Desktop POS | Counter work projects tasks executable on this device/branch with next action, dependency and evidence status; management tasks show an explicit web handoff where permitted | Keep checkout usable; live terminal/attendance/clinical checks remain mandatory. Offline shows only supported local work with last-known freshness; sync never invents central completion |
| Mobile web | Responsive Daily work and module review under existing web auth; count-line entry follows D-W3 | Remote management only; physical posting stays at the counter |
| Native mobile | Build auth/tenant/branch selection and permission-aware navigation first, then consume the shared contract; support safe document deep links with a web fallback until native review exists | No offline approval or physical execution. Cached tasks are labelled stale/read-only; decisions require online revalidation |

Do not expose the entire management queue to PIN-opened counter sessions. Define and test a
restricted counter projection/capability endpoint using the existing Counter work permission
boundary (`GET /counter-work` task fields and [COUNTER_WORK_COVERAGE.md](COUNTER_WORK_COVERAGE.md),
#172). Selecting an unsupported action explains where and who can finish it. An owner using
a browser or phone still cannot bypass local physical execution.

## Delivery slices and acceptance gates

1. **Foundation/reference module:** document this decision; use the shared queue in Sales pending
   approvals; route Daily work and notification links there; preserve exact approval and branch
   race protections. Review/merge the draft MR before claiming delivered checkboxes.
2. **Contract/source consistency:** version the additive task model and source interface, audit
   every workflow mapping, close missing eligibility/status cases and align module pending counts.
3. **Management workspace:** implement cross-branch overview, transparent prioritization, filters,
   assignment and escalation policies in small independently reviewable slices.
4. **Desktop alignment:** integrate the restricted projection with P6 screens and P4/P5 freshness;
   verify approve-on-web → correct-counter execution and recovery on real devices.
5. **Mobile alignment:** responsive web first; native authentication/navigation, read model and
   supported online approval views next. Native delivery is separately gated, not assumed done
   because shared types compile.
6. **Operational acceptance:** verify one cross-module scenario matrix with owners/managers,
   multi-branch/custom-role scope, self-approval, concurrent edits, duplicate/lost responses,
   cancelled/revoked approvals, material changes, partial execution, offline/reconnect/replacement,
   stale cache, timezone boundaries, accessibility and large queues. No duplicate stock/cash effects.

Track a coverage matrix per source and surface (available / handoff / blocked / planned), with
named acceptance evidence, so the rollout cannot imply all apps support every action. Historical
task outcomes come from audited domain transitions; queue telemetry is not a financial ledger.

## Not delivered by this plan

This is not a new generic approval engine, unrestricted cross-branch action API, offline approval
feature, autonomous task executor or finished native app. Existing D10/D11/D13, clinical rules,
self-approval policy and per-domain evidence requirements continue to govern all actions.
