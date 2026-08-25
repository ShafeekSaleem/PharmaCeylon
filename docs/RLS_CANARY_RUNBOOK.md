# RLS canary staging runbook

This runbook activates row-level security for the `product`, `batch`, and
`sale` canary tables in a disposable test or staging environment. It is not a
production rollout approval.

## Safety model

Use two database URLs:

| URL | Role | Usage |
|---|---|---|
| Migration/admin URL | Table owner or controlled database administrator | Prisma migrations and the scripts in this runbook |
| Application URL | Existing `LOGIN NOSUPERUSER NOBYPASSRLS` role that owns no tables | API and worker runtime only |

Keep credentials in the environment's secret manager. The repository scripts
never create a password or print a connection string.

## Prepare the application role

Create the login role through the database provider or a separately audited
administrator session. Then grant runtime privileges with the migration/admin
URL:

```bash
export DATABASE_URL='<migration-admin-url>'
export APP_DATABASE_ROLE='pharmaceylon_app'
export RLS_APP_ROLE_GRANT_ACK='pharmaceylon_app'
npm run rls:role:prepare -w api
```

The command rejects a role that cannot log in, is a superuser, has
`BYPASSRLS`, or owns any application table. It grants DML privileges without
transferring table ownership.

## Pre-activation checks

1. Deploy the complete Prisma migration history with the migration/admin URL.
2. Run `npm run test:rls-canary -w api`; policies must exist while RLS is
   still disabled.
3. Configure the API `DATABASE_URL` with the application role.
4. Set `TENANT_TRANSACTION_CONTEXT_ENABLED=true` and keep
   `RLS_CANARY_ENFORCED=false`.
5. Exercise login, refresh, product search, inventory, checkout, reports, NMRA
   import, workers, seeds, and support scripts. Pre-authentication and
   administrative paths must have an explicit database-role/context decision.
6. Record baseline latency and error rates for product search, batch lookup,
   checkout, and reporting.

The CI command `npm run test:rls-canary-activation -w api` separately creates
an ephemeral non-owner role, activates RLS on the real canary tables, proves
missing-scope and cross-tenant containment through Prisma, measures a scoped
transaction smoke threshold, and restores the database.

## Activate in staging

Stop or drain API and worker traffic. With the migration/admin URL:

```bash
export DATABASE_URL='<migration-admin-url>'
export APP_DATABASE_ROLE='pharmaceylon_app'
export RLS_CANARY_CHANGE_ACK='product,batch,sale'
npm run rls:canary:enable -w api
```

Then set both runtime flags and restart with the application URL:

```dotenv
TENANT_TRANSACTION_CONTEXT_ENABLED=true
RLS_CANARY_ENFORCED=true
```

Startup is fail-closed. It rejects a superuser, `BYPASSRLS` role, canary table
owner, missing transaction boundary, missing table, or a canary table that is
not both `ENABLE` and `FORCE ROW LEVEL SECURITY`.

Verify state with the migration/admin URL:

```bash
npm run rls:canary:status -w api
```

## Validation window

During the staging soak, confirm:

- missing tenant context returns zero canary rows and rejects writes;
- tenant A cannot read, update, or delete tenant B products;
- branch A1 cannot read branch A2 batches or sales;
- tenant-wide workflows intentionally omit `app.branch_id` and still remain
  tenant-isolated;
- request transactions do not exhaust the connection pool;
- p95/p99 latency, lock waits, long transactions, and database errors remain
  within the environment's agreed budget;
- non-HTTP jobs and imports either open a tenant transaction or use an
  explicitly controlled administrative path.

Do not advance to production based only on CI. A representative staging soak
and owner sign-off are required.

## Roll back the staging canary

Drain traffic. Set `RLS_CANARY_ENFORCED=false` for the next deployment, then
use the migration/admin URL:

```bash
export RLS_CANARY_CHANGE_ACK='product,batch,sale'
npm run rls:canary:disable -w api
```

Restart the API and workers. Keep
`TENANT_TRANSACTION_CONTEXT_ENABLED=true` during diagnosis unless the
transaction boundary itself is the verified cause. The policies remain staged,
so the canary can be re-enabled after remediation.
