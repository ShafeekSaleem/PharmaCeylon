# W4 pending refund review through Daily work

This slice implements refund approval review for epic W4 #66 without creating a separate task
store or navigation destination. Managers discover work from **Daily work → Needs my decision**
and review it under **Sales → Pending approvals**. The old `/refund-approvals` URL is only a
compatibility redirect. This does not complete W4's channel filters, incident, offline-sync or
payment-recovery queues.

The module list narrows the shared `GET /dashboard/work` projection to
`sale_refund.approve`. `filter=all` deliberately keeps self-approval blockers visible; the main
Daily work approval filter shows only decisions the caller can make. Search, paging, counts and
facets use the common source registry and snapshot rather than duplicated refund-inbox SQL.

Reviewing a task fetches the domain detail: priced lines, product and batch labels, quantities,
returned-stock disposition, refund method, reason and actor history. Approval pins the displayed
version and digest through the existing command. Successful approval shows the counter handoff;
stock and money still move only during separate physical execution. There is no browser execute
action and no offline approval path.

Access follows live `returns.approve` authority, including custom roles without `sales.refund` or
`sales.view`. The existing self-approval policy remains authoritative. A lowered threshold can
bring a request into review; revoked or missing pinned evidence brings an open request back even
after the threshold is disabled. Notification routing uses the same shared task model and omits
self-blocked decisions.

Every request pins the captured branch. Branch switches unmount the prior review and late replies
are ignored. Duplicate approval clicks are blocked; uncertain responses retry the same approval
ID. A failed approval refreshes evidence before another deliberate action. The list refreshes on
focus or request, not through a live push feed.

W11 #145 owns the generalized contract, adapters, cross-branch manager view, priority signals and
web/desktop/mobile alignment. W9 owns Daily work and notification presentation; W4 owns refund
evidence and commands; W5 owns inventory, purchasing, transfer and stocktake domain adapters.
Nothing in this reference slice claims the broader epic or native mobile work complete.
