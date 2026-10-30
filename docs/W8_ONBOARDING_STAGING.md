# W8 onboarding hours and opening-stock drafts

The branch step can collect W7 structured routine hours (weekly/24-hour/overnight ranges and
dated exceptions) or leave them unset for later. It reuses W7 day controls and shared
`BranchHours` validation. The pre-tenant draft stores this document; completion validates it
again and provisions `Branch.operatingHours`, editor origin and the actual owner's ID. Initial
onboarding never adds mandatory limits: non-null `mandatory` documents are rejected, including
an empty no-selling list. Owners set hard limits through W7's dedicated confirmation flow after
setup. No holiday list is invented. Existing drafts without hours remain valid.

Preferences collect 1–100 planned counters, stored in `Branch.plannedCounterCount` (default 1).
This is a planning preference; it creates no terminals, credentials, grants or stock. It cannot
satisfy enrollment or staff-preparation readiness checks.

Get-started lists recent completed stock drafts for the selected branch, links to
`/products/import?mode=stage` and offers a draft editor. That explicit mode uses
`POST /products/import/stage` even before a branch is live; the ordinary importer retains legacy
posting at a known `not_live` branch. Live, fallback and unknown rollout states use staging.
The import result/history also opens the editor for a completed staged import at this branch.

The editor reads `GET /products/import/:id/stock`. It paginates 25 rows at a time, shows
whole/category posting status and edits existing rows' quantities, cost/selling prices, batches
and expiry dates. It sends the loaded version and full draft through P1's document-sized
multipart `POST /products/import/:id/stock/replace`. It never calls `/stock/post`; physical
posting is done at the counter, in one action or by category, when the desktop screen exists.
Saving a draft neither posts stock nor marks the branch ready.

Any posted row freezes replacement of the whole draft. An HTTP 409 retains unsaved edits and
requires an explicit reload/review. Users without `costs.view`, or whose server view redacts a
cost, can review quantities/status but cannot replace the document or substitute zero costs.
Removing cost permission hides already-loaded cost controls. Requests pin the captured branch
header; keyed branch/editor state and cancelled old reads prevent cross-branch draft display or
saves. Current permissions remain enforced by P1 on the server.

For live branches (including checkout fallback), get-started counts active, unrevoked
enrollments on non-retired terminals, and the checkout task is complete once at least one
counter is enrolled. Staff preparation and verified test receipts are shown as pending facts
but do not gate it: P2 has not supplied those records, and `assertCanSell` refuses every sale
(web fallback included) while a setup task is incomplete, so a branch that went live mid-setup
would otherwise be unable to sell at all. When P2 records them, they join the condition here.
Old web-checkout confirmations cannot satisfy the desktop task or be reconfirmed to do so; the
web confirm endpoint refuses it. Posted opening stock is still confirmed on get-started, because
there is no counter-side confirmation yet. The page offers no web stock-posting or
ready-to-sell action at a live branch. `not_live` branches retain their current web checkout
readiness. No branch rollout state is changed and no installer link is fabricated.

W8 remains open: real counter install/enrollment/staff/test-receipt UI, posting screens and a
verified first desktop sale depend on W6/P2. Blank manual draft creation/product addition and
demo offline/shift/reconciliation fixtures remain separate follow-ups. Editing an imported
draft is available now; after stock is posted, normal counter corrections apply. Get-started
suggests a first full stocktake a few weeks after go-live.
