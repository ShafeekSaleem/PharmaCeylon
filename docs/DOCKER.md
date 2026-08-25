# Docker development guide

This guide introduces Docker to PharmaCeylon one step at a time. Phase 1 runs
PostgreSQL in Docker. Phase 2 adds a production-style image for the NestJS API.
Phase 3 applies committed Prisma migrations through a one-shot container. The
Next.js web app continues to run directly on your computer.

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

This deletes the named volume and cannot be undone unless you have a backup.
The database will be empty the next time it starts, so migrations and seeding
must be run again.

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

An exit code of `0` means success. A non-zero exit means the migration failed;
Compose leaves the API stopped so the schema problem can be investigated rather
than serving requests with incompatible code.

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
