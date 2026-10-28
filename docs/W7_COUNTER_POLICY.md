# W7 counter policy settings

This slice adds a versioned **settings source**, not desktop offline checkout or grant signing.
Settings → Counters & receipts keeps the existing tenant receipt/default settings and adds the
selected branch's offline policy. Counter support and P3 grant/snapshot signing remain later work.

`GET /tenant/branches/:branchId/counter-policy` reads the active branch under the authenticated
tenant, then requires `tenant.management` at that exact branch. `PUT` takes
`{ expectedVersion, policy }`. Both routes declare `tenant.management`; the service rechecks the
path branch independently of the selected header branch. Custom roles with that grant work.
An owner can edit every branch with a live owner role. Other users need a current assignment
and grant at the target. Writes check live membership/token/role authority before and after the
branch row lock, update the loaded version conditionally, and audit in the same transaction.
Stale versions return 409 and require reloading. Null stored policy means disabled defaults;
an invalid saved document fails closed with 503 and is never silently replaced by defaults.

The version-1 policy document contains:

```json
{
  "schemaVersion": 1,
  "offlineEnabled": false,
  "offlineExternalCardEnabled": false,
  "externalCardMerchants": []
}
```

Each merchant is `{ "provider": "Bank", "merchantId": "MID-1" }`. At most 20 entries are
accepted. Values are trimmed and NFC-normalized; provider labels are case-insensitive for
duplicate detection, while merchant IDs retain exact case. Empty/control-character values and
unknown fields are refused. Provider names are limited to 80 characters and IDs to 120. These
are identifiers, never payment credentials. External card offline requires offline enablement
and at least one merchant; disabling offline in the editor disables its external-card switch.

The fixed v1 rules are displayed read-only: original permission expires 24 hours after online
renewal, stock is at most 15 minutes old at original outage entry, ordinary non-prescription/
non-controlled items only, no discounts or overrides, cash and independently approved external
card (including split tender), no wallet/credit. Unknown rule overrides are rejected. Saving
does not nominate a terminal, issue/renew a grant, authorize a card or revoke a disconnected
terminal immediately. P3 must consume the exact policy/version when signing; P2/P4 must enforce
the signed values when their implementations land. Payment reference uniqueness enforcement
belongs to those payment/journal paths and is not claimed by this settings registry.

Still outside this slice: online payment-method configuration, per-register receipt/invoice
prefixes (W6/P2 registry/numbering integration), desktop receipt consumption, grant signing,
approval-rule handoff copy, counter-alert preferences/delivery, and verified holiday data.
