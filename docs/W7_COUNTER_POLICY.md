# W7 counter policy settings

This is a versioned **settings source**, not desktop offline checkout or grant signing. Four
settings pages edit it, each for the selected branch:

| Page | What it edits |
| --- | --- |
| Settings → Counters & receipts | Tenant counter defaults and receipt layout (header, footer, paper size, auto-print, max discount), and each register's receipt/invoice prefixes |
| Settings → Payments | Online payment methods; offline external card and its provider/merchant list |
| Settings → Offline policy | Branch offline enablement; the fixed rules, read-only; who holds the offline manager capabilities |
| Settings → Approval rules | Remote approval versus counter execution; refund-threshold approval remotely or by PIN at the counter |

Every setting that feeds an offline grant or stock snapshot says "Applies to counters after
their next sync." No setting enables, links to or implies web checkout.

## Branch document

`GET /tenant/branches/:branchId/counter-policy` reads the active branch under the authenticated
tenant, then requires `tenant.management` at that exact branch. It returns the document, its
version and the branch's registers (`TerminalCounter` rows, retired ones included). `PUT` takes
`{ expectedVersion, policy }`. Both routes declare `tenant.management`; the service rechecks the
path branch independently of the selected header branch. Custom roles with that grant work.
An owner can edit every branch with a live owner role. Other users need a current assignment
and grant at the target. Writes check live membership/token/role authority before and after the
branch row lock, update the loaded version conditionally, and audit in the same transaction.
Stale versions return 409 and require reloading — which is also what stops two settings pages
editing the same document from overwriting each other. Null stored policy means the defaults;
an invalid saved document fails closed with 503 and is never silently replaced by defaults.

Version 2 (writes must send it):

```json
{
  "schemaVersion": 2,
  "onlinePaymentMethods": ["card", "mobile_wallet", "credit"],
  "offlineEnabled": false,
  "offlineExternalCardEnabled": false,
  "externalCardMerchants": [],
  "registerNumbering": []
}
```

A stored version 1 document (before online payments and numbering) is read as version 2 with
every online method on and no numbering, which is what it meant. The next save writes version 2.

- **Online payment methods.** Cash is always accepted and is not a setting, so payments can
  never put a branch into "no selling". The list holds the other methods the API accepts online;
  the default is all of them, so an unconfigured branch keeps today's behaviour.
- **External card merchants.** Each is `{ "provider": "Bank", "merchantId": "MID-1" }`, at most
  20. Values are trimmed and NFC-normalized; provider labels are case-insensitive for duplicate
  detection, merchant IDs keep their exact case. Empty/control-character values and unknown
  fields are refused. Providers are limited to 80 characters and IDs to 120. These are
  identifiers, never payment credentials. External card offline requires offline enablement and
  at least one merchant; turning offline off turns its external-card switch off too.
- **Register numbering.** `{ "registerId", "receiptPrefix", "invoicePrefix" }` per register, at
  most 50. Prefixes are 1–12 uppercase letters, digits or hyphens (input is upper-cased), starting
  with a letter or digit. Invoice numbers are unique per branch and looked up by prefix, so no
  prefix may begin another — across every register's receipt and invoice series and the online
  `INV-` series. The server refuses a register that isn't a `TerminalCounter` of this tenant and
  branch. Retired registers keep their prefixes (read-only in the editor) so a new register can't
  reuse a series that already has numbers. A register with no entry has no series yet.

## Fixed rules

Displayed read-only: original permission expires 24 hours after online renewal; stock is at
most 15 minutes old at original outage entry; ordinary non-prescription/non-controlled items
only, no discounts or overrides; cash and independently approved external card (including split
tender), no wallet/credit. Unknown rule overrides are rejected. The max-discount setting applies
to online counters only and says so.

## Offline manager capabilities

The grant's `authorizedStaff[].offlineManagerActions` come from two role permissions, so custom
roles work: `sales.offline_hours_acknowledge` (`acknowledge_business_hours`, D8) and
`sales.offline_handover_assist` (`assist_shift_handover`). Owner and manager hold both by
default (migration `20261028120000_offline_manager_permissions`). They protect no endpoint; the
Roles & Permissions editor lists them under "Offline capabilities". Owners hold every permission
at every branch, as elsewhere.

## Grant settings source

`GET /tenant/branches/:branchId/counter-settings` (`tenant.management` at the branch) returns
`CounterGrantSettings` (`packages/shared/src/counter-grant-settings.ts`): every value settings
contribute to an `OfflineGrant`, read from settings alone. It is read-only and signs nothing.

| `OfflineGrant` field | Source |
| --- | --- |
| `externalCardAllowed` | `externalCardAllowed` (offline enabled **and** external card on) |
| `policyVersion` | `sourceVersions.counterPolicy` |
| `maxSnapshotAgeAtOutageMs` | `fixedRules.snapshotFreshnessMinutes` |
| `operatingWindows`, `mandatoryOperatingWindows`, `operatingHoursException` | `hours` (weekly, exceptions, mandatory) and `extensions`, resolved by P3 in `timezone` for the grant's interval; `sourceVersions.operatingHours` |
| `authorizedStaff[].offlineManagerActions` | `offlineManagers` |
| `expiresAt` bound | `fixedRules.permissionHours` |
| identity, register/till, grant ID/version, nomination version, issue times, prepared staff and credential versions, currency | Nomination, enrollment and issuance (P1/P3), not settings |

P3 must re-issue when either source version changes, and must not issue a grant while `hours`
is null (no structured hours to sign) or `offlineEnabled` is false. A unit test fails if a new
`OfflineGrant` field is added without placing it in this table's split.

Saving does not nominate a terminal, issue/renew a grant, authorize a card or revoke a
disconnected terminal immediately. P3 must consume the exact policy/version when signing; P2/P4
must enforce the signed values, online payment methods and register numbering when their
implementations land. Payment reference uniqueness enforcement belongs to those payment/journal
paths and is not claimed by this settings registry.

Still outside W7's delivered work: counter-alert types and recipients (separate PR), verified
holiday data (needs a person to compare the drafts with the original gazettes; see
`apps/api/src/tenant/holidays/README.md`), desktop consumption, and grant signing.
