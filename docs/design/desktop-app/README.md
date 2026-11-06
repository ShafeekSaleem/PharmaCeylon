# PharmaCeylon POS desktop app: UI mockups

Mockups for the Electron counter app (`apps/pos-desktop`), drawn at 1600 × 1000 in light and dark. Colours and icons follow the web back office (`apps/web/src/app/globals.css`).

Open `pharmaceylon-pos-desktop.html` in a browser and use the switcher at the bottom right to change screen and theme. Add `?screen=<name>&theme=light|dark` to open one directly.

| Screen | `screen=` | Images |
| --- | --- | --- |
| Sell | `sell` | `pos-desktop-sell-{light,dark}.png` |
| Prescription in the sale | `rxa` | `pos-desktop-rxa-{light,dark}.png` |
| Returns | `returns` | `pos-desktop-returns-{light,dark}.png` |
| Counter work | `work` | `pos-desktop-work-{light,dark}.png` |
| Stock | `stock` | `pos-desktop-stock-{light,dark}.png` |
| Cash & shift | `cash` | `pos-desktop-cash-{light,dark}.png` |
| This counter | `counter` | `pos-desktop-counter-{light,dark}.png` |
| Sign in | `lock` | `pos-desktop-lock-{light,dark}.png` |
| First-run setup | `setup` | `pos-desktop-setup-{light,dark}.png` |
| Pharmacist queue (later, not v1) | `rxq` | `pos-desktop-rxq-{light,dark}.png` |

`pos-desktop-overview.png` shows the v1 screens on one board. It was made before This counter and First-run setup were added, so it doesn't show them. `pos-desktop-rx-approaches.png` compares the two ways to handle prescriptions.

## Decision: prescriptions are handled inside the sale (1 Nov 2026)

There is no separate Dispense page in v1. When a prescription item is added to a sale, a prescription sheet opens over Sell. The cashier records:

- the patient
- the prescription number
- the doctor, and the SLMC number if there is one
- the issued and valid-until dates
- notes

The pharmacist then enters their own PIN on the same counter, and the sale goes on to payment.

This matches what the P2 branch already builds: `Dispensing.tsx` is part of checkout, not a page of its own. The existing rules stay the same:

- Prescription and controlled items need the counter online (D2).
- The pharmacist's check happens at an enrolled counter.
- A manager's remote approval on the web doesn't count as that check.

Why: most Sri Lankan pharmacies are small. The pharmacist works at or next to the counter, and a typical sale is a few OTC items plus a short prescription. A queue would add steps without saving anyone time.

## For later: pharmacist queue (approach B)

This is kept on file for branches that split the work, with an assistant preparing, a pharmacist checking and a cashier taking payment. It suits busy branches and customers who drop a prescription off and come back for it. The `rxq` mockup shows the Dispense page on a dispensary computer with no cash drawer.

The flow is: handed in → preparing (assistant picks and scans each pack) → pharmacist check (approves with their PIN) → ready to collect (the till scans the bag label and takes payment).

Revisit it when a customer branch runs separate dispensary and till staff, or when collect-later prescriptions are needed.

What it would need beyond v1:

- A prescription status that exists before any sale: handed in, preparing, to check, ready, collected.
- A way to tie the pharmacist's approval to a sale taken on a different counter. D2 today only covers co-signing on the same counter, so this needs a contract change.
- Bag labels, and a till that loads an approved prescription by scanning the label.
- Items owed when stock is short.
- A dispensary computer role with no cash drawer.

## Returns and Stock follow the refunds and inventory code

Both pages follow `origin/claude/p6-sale-refunds`.

**Returns** uses the refund fields from `RefundSaleDto`:

- The refund reason codes.
- Restock or quarantine for each line. Prescription and controlled items default to quarantine.
- One refund method for the whole refund, which defaults to how the sale was paid.
- Quantities that can still be returned after earlier refunds.
- An approver's till PIN for a refund over the limit.

A refund prepared on the web arrives under "From web" and in Counter work, as revised D10 describes.

**Stock** covers the counter side of the inventory code:

- Batches with on-hand, reserved and quarantined quantities.
- Quarantine and release, with their reason codes.
- Adjustment kinds.
- Write-offs from quarantine. Above `approvalRequiredWriteOffThreshold` they become a held adjustment that a manager approves.

The Rs 5,000.00 refund limit and the Rs 10,000.00 write-off limit are only example values.

**Cash & shift** follows D7b and assisted handover in `POS_V1_CONTRACT.md` and `POS_V1_OPERATIONAL_READINESS.md`:

- One shift per till.
- The closing count is recorded against the locally calculated expected cash, and a shortage or overage is kept rather than erased.
- The next person opens a separate shift and counts the drawer under their own PIN. This works offline, and the close shows "not yet synced" until the server confirms it.
- Supplier cash payouts are approved on the web and paid out at the counter, per revised D10.
- A card payment that was approved but whose sale didn't finish is kept apart from sales until it's resolved online.

## First-run setup and This counter follow today's counter panels (3 Nov 2026)

These two screens were added for decision 2 of [Epic P2b #103](https://github.com/ShafeekSaleem/PharmaCeylon/issues/103). They move the panels that `CounterAccess.tsx` and `App.tsx` show today into the mockup layout, without changing what they do.

**First-run setup** is a full screen, like Sign in, shown while the computer isn't enrolled. There's no menu yet, because nobody can sign in. It follows `ServerSetup`, `SignInForm` and `EnrollPanel`:

- The server address, which can only be changed when the build allows it (`serverUrlEditable`).
- An email and password sign-in.
- Enrolling: a manager picks the branch and a free counter, or adds one. Anyone else enters a one-time code that a manager made on the web. Both name the computer.
- The last step is staff signing in once while online to set or prepare their PIN.
- Enrolling and signing in are refused over a remote connection, so the screen shows "At the computer · console session".

The mockup shows a manager on the enroll step. The same screen also covers the other states that `CounterAccess` handles: an enrollment that didn't finish, a revoked or retired computer, and the code path.

**This counter** is a page in the menu. It holds:

- The counter's details: branch, counter and till, computer name, enrollment date and app version.
- The readiness checks from `readiness.ts`, grouped. The counter is ready for an outage only when every check is OK.
- The receipt printer: the printer, a test receipt and "Yes, it came out", which records the test for the go-live checklist.
- The offline backup counter (D13). Everyone sees its status. The Activate button appears only to people allowed to activate, and only after the owner or a delegated manager authorizes this counter on the web. The mockup shows the usual state, with this counter already active.

## Mockup ideas not in the codebase yet

These are proposals, not existing features:

- **Sell:** quick keys, and the "Rx labels" print switch.
- **Prescription sheet:** the webcam photo of the paper prescription.
- **Counter work:** the "Cold chain · 4 °C" check when receiving.
- **Returns:**
  - The "Sealed" and "Box opened" condition tags.
  - Finding a sale by customer phone or by date and amount.
- **Stock:**
  - Shelf labels.
  - The "Sell first" label, which assumes sales take the earliest-expiry batch first.
  - The "Needs attention" list.
  - The "Count this product" button.
  - Stock at other branches shown on the counter.
- **Cash & shift:**
  - Counting by note and coin.
  - The "Print X report" button.
  - The "By hour" takings view.
  - The "End of day" close without a handover.
- **This counter:**
  - Who authorized and activated the offline backup, and when (the API does not yet expose activation time or actor for the listing panel).
  - ~~Who last confirmed the test receipt.~~ **Done in the app:** confirmation shows the person who confirmed when they are the signed-in operator; the server does not return a separate name field on `POST …/test-receipt`.
- **Pharmacist queue (B):** all of it, including the bag label, the checklist, owed items and the controlled-register balance.
