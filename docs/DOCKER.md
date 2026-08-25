# Docker development guide

This guide introduces Docker to PharmaCeylon one step at a time. In Phase 1,
Docker runs PostgreSQL only. The API and web app still run directly on your
computer, preserving the normal hot-reload development workflow.

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

