# Docker development guide

This guide introduces Docker to PharmaCeylon one step at a time. Phase 1 runs
PostgreSQL in Docker. Phase 2 adds a production-style image for the NestJS API.
Phase 3 applies committed Prisma migrations through a one-shot container.
Phase 4 packages Next.js and runs the complete local web stack in Compose.
Phase 5 adds daily commands, readiness verification, bounded logs, and real
Compose lifecycle tests. If you have completed Phases 1-4, start at
[Phase 5](#phase-5-operate-and-verify-the-complete-local-stack).

## What Phase 1 creates

- A PostgreSQL 17 container named by Docker Compose.
- A named volume (`pharmaceylon_postgres_data`) that keeps database data when
  the container is recreated.
- A health check that reports when PostgreSQL can accept connections.
- A database port bound to `127.0.0.1` so it is reachable from your computer,
  but is not intentionally exposed to other devices on the network.

The Compose service is called `db`. Docker Compose generates the container name
from the project and service names, usually `pharmaceylon-db-1`.

## Prerequisites

Install and start Docker Desktop, then verify it in PowerShell:

```powershell
docker version
docker compose version
```

`docker version` should show both **Client** and **Server** sections. If only the
client is shown, start Docker Desktop and wait until the Docker engine is ready.

## First-time setup

Run these commands from the repository root.

### Windows PowerShell

```powershell
Copy-Item .env.docker.example .env.docker
docker compose --env-file .env.docker config
docker compose --env-file .env.docker up -d db
```

### Bash, macOS, or Linux

```bash
cp .env.docker.example .env.docker
docker compose --env-file .env.docker config
docker compose --env-file .env.docker up -d db
```

What these commands do:

1. Create a local configuration file. `.env.docker` is ignored by Git and must
   never contain production secrets.
2. Render and validate the final Compose configuration without starting it.
3. Pull the PostgreSQL image if necessary and start the `db` service in detached
   mode (`-d`), returning the terminal to you.

## Check the database

```powershell
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs -f db
```

In `docker compose ps`, the database should eventually show `healthy`. Press
`Ctrl+C` to stop following logs; this does not stop the container.

You can also ask PostgreSQL directly:

```powershell
docker compose --env-file .env.docker exec db pg_isready -U postgres -d pharmaceylon
```

Expected output:

```text
/var/run/postgresql:5432 - accepting connections
```

## Connect the PharmaCeylon API

Copy the API environment example if you have not already done so:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
```

The existing development connection string already matches the Phase 1
container:

```dotenv
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/pharmaceylon?schema=public"
```

It uses `localhost` because the API is still running on your computer. In a
future phase, when the API runs inside Compose, its database host will become
`db`, because containers reach each other using Compose service names.

Apply migrations and optionally seed demo data from the repository root:

```powershell
npm run prisma:migrate -w api
npm run prisma:seed -w api
```

Then start the API and web apps as usual:

```powershell
npm run dev
```

## Daily commands

| Goal | Command |
| --- | --- |
| Start PostgreSQL | `docker compose --env-file .env.docker up -d db` |
| View status | `docker compose --env-file .env.docker ps` |
| Follow database logs | `docker compose --env-file .env.docker logs -f db` |
| Open a PostgreSQL shell | `docker compose --env-file .env.docker exec db psql -U postgres -d pharmaceylon` |
| Stop the container | `docker compose --env-file .env.docker stop db` |
| Stop and remove containers | `docker compose --env-file .env.docker down` |
| Pull a newer PostgreSQL 17 image | `docker compose pull db` |

`docker compose down` does not delete the named database volume. When the
service starts again, the data remains available.

## Reset the local database

Only use this when you intentionally want to delete all local PostgreSQL data:

```powershell
docker compose --env-file .env.docker down --volumes
```

This deletes **both the database and uploaded-file volumes** and cannot be undone
unless you have backups. The database will be empty the next time it starts.
Do not use this to fix a port conflict, restart problem, or failed migration.

## Troubleshooting

### Port 5432 is already in use

Another PostgreSQL installation may already be listening on the default port.
Change only the host port in `.env.docker`, for example:

```dotenv
POSTGRES_PORT=5433
```

Then update the API connection string to use `localhost:5433` and recreate the
container:

```powershell
docker compose --env-file .env.docker down
docker compose --env-file .env.docker up -d db
```

### PostgreSQL stays unhealthy

Inspect its status and logs:

```powershell
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs db
```

If a volume was created with different credentials earlier, changing the values
in `.env.docker` does not rewrite that existing database. Either restore the old
values or intentionally reset the local volume.

## Phase 1 completion checklist

- `docker compose ... config` reports no errors.
- The `db` service reports `healthy`.
- Prisma migrations complete against the container.
- The API health-readiness endpoint succeeds after the API starts.
- PostgreSQL data remains after `docker compose down` and another `up`.

## Phase 2: run the API from an image

Phase 2 packages the API, its production dependencies, the generated Prisma
client, and compiled JavaScript into the `pharmaceylon-api:local` image. The
source TypeScript and build-only dependencies are not used when the container
starts.

The Dockerfile uses several stages:

| Stage | Purpose |
| --- | --- |
| `base` | Provides Node.js 22 and required operating-system libraries. |
| `pruner` | Uses Turborepo to keep only the API and shared workspace inputs. |
| `builder` | Installs dependencies, generates Prisma, and compiles the API. |
| `runtime` | Runs only the compiled API as the non-root `node` user. |

The final image is an immutable template. Compose creates a running API
container from that image and supplies environment-specific configuration at
runtime.

### Update your local Docker environment

If `.env.docker` already exists, do not overwrite it. Add the following Phase 2
values and preserve any local customization such as `POSTGRES_PORT=5433`:

```dotenv
API_PORT=3001
WEB_ORIGINS=http://localhost:3000
JWT_ACCESS_SECRET=local-docker-access-secret-change-before-production
JWT_REFRESH_SECRET=local-docker-refresh-secret-change-before-production
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=1209600
USER_CONTEXT_TTL_SECONDS=30
OPENAPI_ENABLED=true
STRUCTURED_HTTP_LOG=true
```

These JWT values are only for development on your computer. Never reuse them in
a shared, staging, or production environment.

### Understand the two PostgreSQL ports

If your `.env.docker` contains `POSTGRES_PORT=5433`, the connections are:

| Client | Database address | Reason |
| --- | --- | --- |
| API running on your computer | `localhost:5433` | It enters Docker through the published host port. |
| API running in Compose | `db:5432` | It uses the private Compose network and PostgreSQL's internal port. |

The containerized API receives `db:5432` automatically from `compose.yaml`.
Do not change it to `db:5433`; `5433` exists only on the host side of the port
mapping.

### Database migrations

Phase 3 adds a dedicated one-time migration container. Starting the API through
Compose now applies committed migrations automatically before the API starts.
Use `prisma migrate dev` on your computer only when developing and committing a
new migration.

### Build the API image

Stop the host-running NestJS API first so port `3001` is available. The web app
may remain running.

From the repository root:

```powershell
docker compose --env-file .env.docker build api
```

`build` executes the Dockerfile and creates the image. It does not start an API
container. Inspect the result:

```powershell
docker image ls pharmaceylon-api
```

### Start the API container

```powershell
docker compose --env-file .env.docker up -d api
docker compose --env-file .env.docker ps
```

Compose waits for `db` to report healthy before starting `api`. The API should
then progress from `health: starting` to `healthy`.

Check its logs and endpoints:

```powershell
docker compose --env-file .env.docker logs -f api
```

Press `Ctrl+C` after observing the startup logs, then run:

```powershell
Invoke-RestMethod http://localhost:3001/api/v1/health
Invoke-RestMethod http://localhost:3001/api/v1/health/ready
```

The liveness endpoint confirms the Node.js process responds. The readiness
endpoint additionally confirms that it can query PostgreSQL through the private
Compose network.

The locally running Next.js app can continue using
`API_PROXY_TARGET=http://127.0.0.1:3001`, because the API container publishes
port `3001` back to the host.

### Image rebuilds versus container restarts

- Configuration-only changes in `.env.docker` require recreating the container:
  `docker compose --env-file .env.docker up -d --force-recreate api`.
- Source-code changes require rebuilding the immutable image:
  `docker compose --env-file .env.docker up -d --build api`.
- A normal restart reuses the existing image:
  `docker compose --env-file .env.docker restart api`.

### Uploaded-file persistence

The API writes uploads to `/app/apps/api/storage/uploads` inside the container.
Compose mounts the `pharmaceylon_api_uploads` named volume there, so recreating
the API container does not delete uploaded files.

Inspect the volume:

```powershell
docker volume inspect pharmaceylon_api_uploads
```

As with the database volume, `docker compose down --volumes` deletes this data.

### Phase 2 completion checklist

- `docker compose ... build api` creates `pharmaceylon-api:local`.
- Both `db` and `api` report `healthy`.
- `/api/v1/health` responds successfully.
- `/api/v1/health/ready` confirms database connectivity.
- The locally running Next.js app works through the containerized API.
- API logs appear through `docker compose logs api`.

## Phase 3: one-shot database migrations

The `migrate` service runs `prisma migrate deploy`. It waits for PostgreSQL to
be healthy, applies all pending migration files, and exits. The API depends on
that successful exit, so it cannot start against an outdated schema.

```mermaid
flowchart LR
    DB["db becomes healthy"] --> Migrate["migrate applies Prisma files"]
    Migrate --> Success["migrate exits 0"]
    Success --> API["api starts"]
```

An exit code of `0` means success. A non-zero exit blocks dependent API/web
startup. This dependency gate does not stop an API that was already running:
stop API/web before deliberately testing a migration failure or performing a
schema change incompatible with the old application.

### Why migrations use a separate image target

The long-running API should not contain migration tooling or TypeScript build
dependencies. The Dockerfile therefore produces two related images:

| Image | Lifetime | Contains |
| --- | --- | --- |
| `pharmaceylon-api-migrate:local` | Runs once and exits | Prisma CLI, migration history, config, and required dependencies |
| `pharmaceylon-api:local` | Long-running service | Production dependencies and compiled API only |

Both are built from the same source revision, preventing the application image
and migration history from drifting apart.

### `migrate dev` versus `migrate deploy`

| Command | Where it belongs | Purpose |
| --- | --- | --- |
| `prisma migrate dev` | Developer computer | Creates and tests new migration files while changing the schema. |
| `prisma migrate deploy` | Migration container/CI/deployment | Applies existing committed migrations without creating new ones. |

The migration container uses `deploy`. It never invents schema changes and does
not run the seed script.

### Build both images

From the repository root:

```powershell
docker compose --env-file .env.docker build migrate api
```

Docker can reuse the shared builder layers, so the two targets do not require
performing every build step twice.

Inspect both images:

```powershell
docker image ls pharmaceylon-api*
```

### Run only the migration job

You can safely run the migration job manually whenever you want to check for
pending migrations:

```powershell
docker compose --env-file .env.docker run --rm migrate
```

If the database is already current, Prisma reports that there are no pending
migrations and the temporary container is removed because of `--rm`.

### Start the ordered stack

Stop the existing API container so you can clearly observe the dependency flow:

```powershell
docker compose --env-file .env.docker stop api
docker compose --env-file .env.docker up -d --build api
docker compose --env-file .env.docker ps --all
```

The expected lifecycle is:

1. `db` becomes healthy.
2. `migrate` runs and exits with code `0`.
3. `api` starts and becomes healthy.

The migration container showing `Exited (0)` is correct. It is a completed job,
not a failed or missing service.

Inspect its output:

```powershell
docker compose --env-file .env.docker logs migrate
```

Then verify the API and database connection:

```powershell
Invoke-RestMethod http://localhost:3001/api/v1/health
Invoke-RestMethod http://localhost:3001/api/v1/health/ready
```

### When a migration fails

Do not bypass the migration dependency or manually mark it successful. Read the
logs first:

```powershell
docker compose --env-file .env.docker logs migrate
```

After correcting the migration or configuration, rebuild and run it again:

```powershell
docker compose --env-file .env.docker build migrate
docker compose --env-file .env.docker run --rm migrate
docker compose --env-file .env.docker up -d api
```

Prisma migrations are expected to be forward-moving and reviewed before
deployment. Database backups and safe expand/contract schema changes will be
part of the later production deployment phase.

### Local versus future production database roles

The local Compose stack currently uses the PostgreSQL owner credentials for both
migration and application connections. That is acceptable for local learning.
In an RLS-enabled staging or production environment, the migration job must use
the migration-owner role, while the API must use the restricted non-owner,
`NOBYPASSRLS` application role.

### Phase 3 completion checklist

- Both migration and API images build successfully.
- `docker compose run --rm migrate` exits successfully.
- `docker compose up -d api` orders `db`, `migrate`, then `api`.
- `migrate` appears as `Exited (0)` in `docker compose ps --all`.
- The API becomes healthy only after migration completion.
- The readiness endpoint confirms PostgreSQL connectivity.

## Phase 4: containerize Next.js

Phase 4 packages the Next.js application using standalone output and adds it as
the `web` Compose service. The browser now enters through the web container,
while Next proxies API and upload requests to the API over Docker's private
network.

```mermaid
flowchart LR
    Browser["Browser localhost:3000"] --> Web["web container :3000"]
    Web -->|"api:3001"| API["api container :3001"]
    API --> DB["db container :5432"]
```

### Browser addresses versus Docker service names

The browser runs on Windows, outside Docker. It can use `localhost`, but it
cannot resolve Compose service names such as `web`, `api`, or `db`.

| Connection | Address |
| --- | --- |
| Browser to Next.js | `http://localhost:3000` |
| Browser API URL | `http://localhost:3000/api/v1` |
| Next.js container to NestJS | `http://api:3001` |
| NestJS container to PostgreSQL | `db:5432` |

The browser uses the same Next.js origin for page and API requests. Next's
server-side rewrite forwards `/api/v1/*` and `/uploads/*` to `api:3001` without
exposing the Docker hostname to browser JavaScript.

### Standalone Next.js output

`output: "standalone"` makes Next.js trace and copy the production files needed
by its server. `outputFileTracingRoot` is set to the repository root so the
standalone output also includes dependencies from `packages/shared`.

The final `pharmaceylon-web:local` image contains the standalone server, static
assets, and public files. It runs as the non-root `node` user and does not need
the complete monorepo or the Next.js CLI at startup.

### Update `.env.docker`

Add these Phase 4 settings to the existing file:

```dotenv
WEB_PORT=3000
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000/api/v1
API_PROXY_TARGET=http://api:3001
```

`NEXT_PUBLIC_API_BASE_URL` is embedded into browser JavaScript during the image
build. `API_PROXY_TARGET` is used to generate the server rewrite manifest during
that same build. If either value changes, rebuild the web image.
`API_PROXY_TARGET` must remain `http://api:3001` for this Compose stack.

If host port `3000` is already occupied and you choose another port, update all
three related values consistently. For example:

```dotenv
WEB_PORT=3002
NEXT_PUBLIC_API_BASE_URL=http://localhost:3002/api/v1
WEB_ORIGINS=http://localhost:3002
```

The internal `API_PROXY_TARGET` still remains `http://api:3001`.

### Build the complete application images

Stop any host-running Next.js and NestJS processes first so ports `3000` and
`3001` are available. Then run:

```powershell
docker compose --env-file .env.docker build migrate api web
```

Inspect the images:

```powershell
docker image ls pharmaceylon-*
```

### Start the full stack

Starting `web` automatically starts everything it depends on:

```powershell
docker compose --env-file .env.docker up -d web
docker compose --env-file .env.docker ps --all
```

Expected state:

| Service | Expected status |
| --- | --- |
| `db` | Running and healthy |
| `migrate` | Exited successfully with code `0` |
| `api` | Running and healthy |
| `web` | Running and healthy |

Open the application at:

```text
http://localhost:3000
```

Verify both the web server and its API proxy from PowerShell:

```powershell
Invoke-WebRequest http://localhost:3000
Invoke-RestMethod http://localhost:3000/api/v1/health
Invoke-RestMethod http://localhost:3000/api/v1/health/ready
```

The second and third commands deliberately use port `3000`. A successful result
proves the request passed through Next.js and reached the API container.

### Observe the stack

Follow web and API logs together:

```powershell
docker compose --env-file .env.docker logs -f web api
```

Press `Ctrl+C` to stop following logs without stopping containers.

View resource usage:

```powershell
docker stats
```

### Rebuild after changes

The containerized stack runs compiled production output, not hot reload.

- Next.js source or public assets changed: rebuild `web`.
- API source changed: rebuild `api` and `migrate` so code and migrations remain
  aligned.
- `NEXT_PUBLIC_*` changed: rebuild `web` because public variables are embedded
  during `next build`.
- Runtime-only API secrets changed: recreate `api`; an image rebuild is not
  required.

Rebuild and recreate the full stack with:

```powershell
docker compose --env-file .env.docker up -d --build web
```

For rapid day-to-day coding, it remains valid to run API/web processes on the
host with hot reload and keep only PostgreSQL in Docker. The full container stack
is for production-like verification and deployment preparation.

### Stop the stack

```powershell
docker compose --env-file .env.docker down
```

This removes the containers and network but preserves PostgreSQL and upload
volumes. Do not add `--volumes` unless you intentionally want to erase that
local data.

### Phase 4 completion checklist

- The migration, API, and web images build successfully.
- `web`, `api`, and `db` report healthy.
- `migrate` exits successfully.
- `http://localhost:3000` loads the application.
- `http://localhost:3000/api/v1/health` works through the Next.js proxy.
- Login/auth cookies and API calls work through the same browser origin.
- Uploaded files load through `/uploads/*` via the web proxy.

## Phase 5: operate and verify the complete local stack

You already have all four services. This phase makes their daily operation and
verification consistent. It does not activate RLS, seed demo data, change your
database credentials, add Redis, or deploy anything to a server.

### Start here after Phase 4

Keep your existing `.env.docker`; **do not copy over it**. No new variables are
required. Your chosen `POSTGRES_PORT` can remain `5432` or `5433`.

Use a current Docker Desktop with Compose supporting `up --wait` and
`--wait-timeout` (Compose 2.20+ or newer). Host Node.js 22 is recommended for
the npm helpers; they use no installed project dependencies. Application
dependencies are installed inside the image builds.

Stop any host-running API/web processes, then run from the repository root in
PowerShell, Bash, or Terminal:

```powershell
npm run docker:config
npm run docker:up
npm run docker:check
npm run docker:ps
```

On a new checkout only, create `.env.docker` from `.env.docker.example` first.

| Command | What you are learning |
| --- | --- |
| `docker:config` | Validates configuration quietly, without printing rendered secrets. |
| `docker:up` | Builds images, creates/recreates containers, starts dependencies, and waits for health. |
| `docker:check` | Reads container states and probes the actual web/API/database request path. It writes no data. |
| `docker:ps` | Includes stopped containers, so the successful migration job remains visible. |

`docker:up` expands to:

```powershell
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 180 web
```

The same stack can also run in the foreground with logs:

```powershell
docker compose --env-file .env.docker up --build
```

The npm helper selects `web`, which brings up its dependencies. `--wait` waits
for health, and `--wait-timeout 180` bounds the final readiness wait; it is not
a total image-build or migration time limit. A slow first build can take several
minutes. A timeout does not remove containers: inspect logs before retrying.

Expected state after success:

| Service | State | Why |
| --- | --- | --- |
| `db` | Running, healthy | PostgreSQL accepts connections. |
| `migrate` | Exited (0) | Committed migrations finished successfully. |
| `api` | Running, healthy | Its readiness endpoint can query PostgreSQL. |
| `web` | Running, healthy | Next.js serves a page after the API becomes ready. |

Open `http://localhost:3000`, or the host port set in `WEB_PORT`.

### What `docker:check` verifies

The checker reads Compose's resolved settings in memory, without logging secrets.
It verifies all four states, then checks the web HTML page, API liveness and
readiness directly, and the same two API endpoints through the Next.js proxy.
An HTTP 200 alone is not enough: readiness must return `ok: true` and
`database: true`. Each HTTP request has a five-second timeout; failures exit
non-zero. Run this after startup finishes, not while containers are still warming.

The checker also catches inconsistent browser configuration. If you use web
port `3002`, these three settings must agree:

```dotenv
WEB_PORT=3002
NEXT_PUBLIC_API_BASE_URL=http://localhost:3002/api/v1
WEB_ORIGINS=http://localhost:3002
```

Keep `API_PROXY_TARGET=http://api:3001`. Rebuild `web` after changing its build
arguments; restart alone cannot rewrite an already-built JavaScript bundle.
The checker validates current Compose configuration and HTTP behavior, not every
URL embedded in a stale browser bundle. Use `docker:up` after source/config changes.

### Everyday commands

| Goal | Command |
| --- | --- |
| Rebuild and start after pulling code | `npm run docker:up` |
| Start existing images without rebuilding | `npm run docker:start` |
| Build all three application images only | `npm run docker:build` |
| Check status / request path | `npm run docker:ps` / `npm run docker:check` |
| Follow the last 100 log lines | `npm run docker:logs` |
| Follow only web/API | `npm run docker:logs -- web api` |
| Inspect migration output | `docker compose --env-file .env.docker logs migrate` |
| Re-run committed migrations using the built image | `npm run docker:migrate` |
| Stop but keep containers | `npm run docker:stop` |
| Remove containers/network, retain both named volumes | `npm run docker:down` |
| Start only PostgreSQL | `npm run docker:db` |
| Inspect resource use | `docker stats` |

`docker:start` requires already-built images. `docker:migrate` uses the existing
migrator image; build first if migration files have changed. Press `Ctrl+C` to
stop following logs without stopping the services. Log rotation now retains at
most three 10 MB files per container, limiting local log disk growth.

`docker:db` does not stop API/web containers that are already running. To switch
back to hot-reload development:

```powershell
docker compose --env-file .env.docker stop web api
npm run docker:db
npm run dev
```

Your host API then needs `localhost:POSTGRES_PORT` in `apps/api/.env`; the
container API always uses `db:5432`. Ensure the host web configuration uses the
host API target, normally `http://127.0.0.1:3001`.

### Networking and persistence

All services remain on the project-scoped `pharmaceylon_default` bridge network.
Only loopback host ports are published. This is local isolation, not a production
firewall: containers on that network can communicate with one another, and
outbound access remains available for features such as NMRA imports.

Existing volume names remain `pharmaceylon_postgres_data` and
`pharmaceylon_api_uploads`. Do not change the Compose project name or use `-p`
for your everyday stack: another project gets different, initially empty volumes,
which can make your data appear missing. There is intentionally no destructive
`docker:reset` npm shortcut.

For a manual persistence check, note an existing product and uploaded logo,
run `docker:down`, then `docker:start` and `docker:check`. Sign in and confirm
both remain. These commands do not delete named volumes, but persistence is
not a backup; production backup/restore procedures remain a later phase.

### What CI proves, and what you still test manually

The `docker-stack` job starts the actual Compose file on an empty, disposable
database, separate from the application/RLS test database. It uses host DB port
5433 and web port 3002 to exercise non-default port configuration. It verifies:

- Full migration history applies before API/web startup.
- Container health, API database readiness, and the Next.js API proxy.
- Both application containers run as non-root users.
- The uploads volume is writable and files load through the web proxy.
- A migration rerun does not duplicate history.
- A test database record and upload survive container/network removal and recreation.
- A deliberately failing migration blocks API/web from starting on a stopped stack.

The lifecycle script refuses to run without the CI environment, a specifically
named CI project, and an explicit disposable-project acknowledgement. It must
never be pointed at your everyday development database. Only CI cleanup deletes
that CI project's volumes. The ordinary `docker:check` command is read-only.

Health checks do not prove every business flow. Before calling your local stack
fully verified, manually test login/logout/refresh, tenant/branch switching,
product search, inventory, a test checkout, reports, upload retrieval, and an
NMRA import. Use local test data. A newly migrated database is empty until you
explicitly run the existing seed process described in [LOCAL_DEV.md](LOCAL_DEV.md).

Docker health status is diagnostic; `restart: unless-stopped` restarts exited
processes, not a process merely marked unhealthy. Compose startup dependencies
do not provide ongoing failover or production orchestration.

### Scope after Phase 5

This remains a local HTTP setup using local owner database credentials, insecure
HTTP cookies, and disabled RLS flags. It is not production-ready simply because
the images run. Phase 6 adds registry publication, immutable tags and vulnerability
scanning; deployment, TLS, restricted database roles, RLS activation, backups,
and shared upload storage follow when an environment exists. Redis/mobile stay
outside this stack for now.

Official references: [Compose startup ordering](https://docs.docker.com/compose/how-tos/startup-order/),
[Compose up](https://docs.docker.com/reference/cli/docker/compose/up/),
[Compose networking](https://docs.docker.com/compose/how-tos/networking/), and
[Compose down / volume behavior](https://docs.docker.com/reference/cli/docker/compose/down/).
