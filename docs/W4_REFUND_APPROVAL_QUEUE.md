# W4 refund approvals

Implements the refund approvals queue and notification slice of epic W4 #66. It does not
complete W4's counter/channel sales filters or incident, offline-sync and payment recovery queues.

Managers open **Sales → Refund approvals** for the active branch. The server paginates the
oldest waiting requests and searches refund or invoice numbers. Reviewing a row fetches current
priced lines, product and batch names, quantities, returned-stock disposition, refund method,
reason and requester/approver history. Approving pins the displayed version/digest through the
existing approval command; successful approval shows the counter handoff and removes the request
from the inbox. No browser execution action is offered.

Access follows `returns.approve`, including custom roles without `sales.refund` or `sales.view`.
The server rechecks live authority for the inbox and existing approval command. The existing
self-approval setting remains authoritative. Own requests that need another approver remain
visible but cannot be approved; their notifications are suppressed.

The inbox, dashboard daily work and sales notifications share the waiting predicate. A lowered
threshold brings a previously exempt request into review. Revoked or missing pinned approval
evidence brings an open request back, including after a threshold is switched off. Approval
continues to enforce exact content, current permissions and self-approval rules transactionally.
Read-side readiness is guidance; physical execution still revalidates authority and sale limits.

All browser requests explicitly pin the captured branch. Switching branches unmounts the old
review and ignores late replies. Duplicate clicks are blocked; uncertain responses can retry the
same approval ID. Failed approvals refetch the review and require a deliberate new click. The
list refreshes on focus or Refresh; it is not a live push feed.

Validation covers API/DTO boundaries, real PostgreSQL pagination/scoping/threshold/revocation,
unchanged stock and money on approval, notification routing, self-approval restrictions,
branch-response races, stale evidence, duplicate/lost-response retry and server-side search.
Browser smoke checks use real local login/inbox reads and isolated response fixtures for light,
dark and narrow layout review; they do not prepare or approve refunds in the demo database.
