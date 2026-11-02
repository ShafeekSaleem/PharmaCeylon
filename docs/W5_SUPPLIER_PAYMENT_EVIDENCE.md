# W5 supplier-payment evidence flow

Part of epic #67. The shared RecordPaymentModal serves Purchasing and supplier detail.

- Bank transfer, cheque and card require a reference and one private PDF/JPEG/PNG/WebP document, at most 5 MB. The web shows exact invoice allocations before recording. Oldest-first allocation is frozen at review; the server revalidates current invoice balances. A branch may pay its own invoices and those raised for the business as a whole (no branch), the same set the invoice list shows. A double-click on "Review payment" stops at the review.
- Upload and payment requests use the same immutable payment material. A scoped session recovery record retains the evidence ID, payment request and idempotency key, but never document bytes. Reload/reopen retries the original payment; interrupted uploads require selecting the original document. Recovery is scoped to tenant, user and branch and lasts for the browser tab session; a browser that refuses storage still records, without recovery after a reload. Check payment history if that session is lost. Evidence IDs are generated without `crypto.randomUUID` where the page isn't a secure context (plain HTTP on a LAN).
- After a definite refusal (a 4xx other than 408/429), the message says the payment was not recorded and unused evidence can be revoked before editing; only uncertain failures ask for a retry. Consumed evidence cannot be discarded. Private downloads use authenticated, branch-scoped API requests; history responses contain only evidence ID and media type.
- Cash/other keep the existing route while the web is in charge: known not-live branches and an owner's fallback. Live and unknown branches refuse them on the web. No counter screen records supplier cash payouts yet, so at a live branch they can't be recorded anywhere: don't take a branch live while it pays suppliers in cash, until that screen exists. This does not cut over the legacy API routes.
- Documents support the user's payment record; they do not prove independently verified bank settlement.

## Manual acceptance

1. From Purchasing and supplier detail, review a bank/cheque/card payment against one or several invoices; confirm the document, reference and allocations before recording.
2. Verify the payment appears once, invoice balances update, and authorized users can download its evidence. A user without suppliers.pay must not download evidence.
3. Drop the recording response, reopen/reload the modal and retry. Confirm the original payment is returned without a second allocation or financial effect.
4. Interrupt upload, reload and select the same document. Retry with the same evidence identity. After a refused unused binding, revoke it, edit and review again.
5. Change branch/user during upload: no subsequent payment request should be started in the new context. Return to the original context to recover.
6. Verify cash/other are available at a known not-live branch and during a fallback, and unavailable on live/unknown rollout. Keep branch cutover gated on supported local workflows.
