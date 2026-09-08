# Phase 6 and 7: stock safety and import recovery

Base: develop `db140a77db0a2245949eb54b32b996de3ca07a8f`.

## Delivered

- POS list, automatic FEFO and explicit checkout reject batches whose expiry needs review. Inventory offers a permission-gated, audited date confirmation. Recording an already-expired date does not make it sellable. Transfer receipt rejects an unresolved source expiry to prevent losing that restriction at the destination.
- Login and existing-account invitation acceptance share password verification, account lockout, failed-attempt tracking and reset logic.
- Import creation and its idempotency record commit together; concurrent retries return one import. Reusing a key with different file/mapping/branch/decisions is rejected.
- Each product/stock chunk locks its running import and saves committed counters in the same transaction. Row SQL errors roll back to a savepoint. A stopped/undone import cannot accept another chunk.
- Failed partial imports can be undone only before any stock or product history prevents it. Undo locks parent records before rechecking history, and writes its audit event in the same transaction.
- Undo removes only products created by that import and its own batches/ledger entries. Enrichment of pre-existing products is retained and reported; undo is not a full before-image restore.
- Completion and its audit event commit together with retries. The durable result survives restart and cross-instance polling. Follow-up catalog errors are reported separately from a successful stock import.
- Rejected rows and partially imported rows have independent totals. UI details are sampled at 500 issues; the downloadable error report retains all issues.
- Catalog refresh processes every keyset page, including catalogs above 5,000 matching products. Bulk safe apply processes every matching page, including over 200 tasks, and moves past failures without looping.
- CI runs frontend tests and a disposable PostgreSQL integration check for partial recovery, idempotency and concurrent undo.

## Migration / local verification

With PostgreSQL running and API DATABASE_URL configured, from the repository root:

```sh
npm ci
npm run prisma:deploy -w api
npm run prisma:generate -w api
npm run lint -w api
npm test -w api -- --runInBand
npm test -w web -- --runInBand
npm run build -w api
npm run build -w web
```

The additive migrations are `20260907190000_import_recovery` and `20260908060000_stage_catalog_import_policies`. The latter completes the existing disabled tenant-policy inventory for the three newer catalog/import tables without activating RLS. No reseed or database reset is required. Stop application workers before rolling back the application to a version that does not understand the new recovery rules; retain the added columns.

`npm run test:import-recovery -w api` requires a separate disposable migrated database and `PHASE67_DB_TEST_ACK=ephemeral-database`. Never point this test at your working pharmacy database.

## Recovery for an interrupted import

Open Recent imports and inspect the saved product and batch counts. If the import is untouched, use Undo before importing the file again with a new request key. Matched existing products retain their enrichment. If undo is blocked because products were traded or stock moved, reconcile those records and import only the missing rows. Automatic mid-file resumption is not claimed or enabled.

## Remaining release gates

Phase 8: full browser journeys (owner, invited staff, branch changes, import errors, stock correction, completion and first sale), responsive/keyboard checks and realistic catalog performance measurements.

Phase 9: backup restoration, upgrade rehearsal on a representative database, production email/monitoring, deployment rollback and a supervised pharmacy pilot. Production RLS activation remains its own rollout gate.
