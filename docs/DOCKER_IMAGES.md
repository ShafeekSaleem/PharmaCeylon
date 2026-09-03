# Docker Phase 6: versioned images and registry releases

Phase 5 builds images on your computer. Phase 6 also lets CI build, test, scan,
and publish them once so another computer can pull the exact same images.
This is a local HTTP release workflow, not a production deployment.

## What is published

| Image | Purpose |
| --- | --- |
| `ghcr.io/shafeeksaleem/pharmaceylon-api` | Compiled NestJS application |
| `ghcr.io/shafeeksaleem/pharmaceylon-api-migrate` | Committed Prisma migrations and CLI |
| `ghcr.io/shafeeksaleem/pharmaceylon-web` | Next.js standalone server and browser assets |

All three use one tag of the form `sha-<full-commit>-run-<run-id>-<attempt>`.
The run suffix prevents a rerun with updated base packages from replacing an
earlier build's tag. No `latest` tag is published. Tags are still registry
references, not cryptographic immutability: the release lock uses `@sha256:...`
digests to identify exact image contents.

Initially images are `linux/amd64`, matching common Windows/Intel Docker Desktop
and x86 servers. ARM hosts need emulation; native ARM publishing is not included.
PostgreSQL remains the upstream PostgreSQL 17 image, not an application image.

## Publication gates

Pushes and PRs targeting `develop` or `main` run application tests and builds.
They do not run the Docker stack or receive GHCR write permissions before the
change reaches `main`.

After a commit reaches `main` in `ShafeekSaleem/PharmaCeylon`, the application
build/test job and Docker stack job must pass. The Docker job runs the container
lifecycle tests, vulnerability scans, and disposable localhost registry
push/pull test. A separate publishing job loads the exact tested image archive,
checks image IDs and revision labels, then authenticates using GitHub's temporary
`GITHUB_TOKEN` with `packages: write`. It does not rebuild the images.
The publisher also verifies through GitHub's API that this exact commit is the
merge commit of a PR into `main`; direct pushes cannot publish. This includes
normal merge and squash-merge commits. Use branch protection to require reviews
and prevent direct pushes too; branch protection is not changed by this PR.
`develop` pushes and all PR runs do not build, scan, or publish Docker images.

Each pushed image is pulled back and its identity checked. A separate job with
only package-read permission starts the digest-pinned release bundle on a
disposable database, checks the request path, and changes the browser port
without rebuilding. Only that successful job exposes the final `release-bundle`
artifact. A failed partial publication emits no verified release bundle; do not
deploy images merely because a tag exists.

No staging/production server is contacted and no merge happens automatically.
GHCR publication happens only after a PR is merged into `main`, not on its PR.

## Security scanning

Trivy is downloaded at a fixed version and its archive SHA-256 is verified before
execution. Added Actions are pinned to commit SHAs. Scans cover OS and application
dependencies in all three application images; reports and CycloneDX SBOMs are
retained as CI artifacts. Scanner/database failures fail the job.

The initial gate blocks **HIGH and CRITICAL vulnerabilities with a vendor fix**.
Unfixed HIGH/CRITICAL findings remain visible in logs and complete reports for
review; a green gate does not mean zero vulnerabilities or production approval.
Lower-severity findings are also present in the JSON reports. There is no blanket
ignore file. Review outstanding findings before exposing any deployment publicly.
This gate does not include a source-secret scan or guarantee that software is safe.

Update vulnerable dependencies/base images and rerun CI. Do not lower the gate
or hide findings just to publish. SBOMs describe components; they are not signed
provenance attestations. Images are scanned at build time, not continuously.

## First publication after merge

1. Merge the release PR into `main` after its build-and-test check passes.
2. Open **Actions → CI** for the resulting `main` commit.
3. Confirm `build-and-test`, `docker-stack`, `publish-images`, and
   `verify-published-images` all succeed.
4. Check the three packages under your GitHub account's **Packages** page.
5. Download that run's **release-bundle** artifact and extract it.

GHCR packages default to private on first publication; this workflow does not
make them public. Keep them private. If a package already exists, check that it
is linked to this repository and grants the repository Actions write/read access.
The OCI source label helps associate new packages with the repository.

If publishing fails with permission errors, inspect the failed step and package
access settings. Do not add a broad personal token to CI: it is designed to use
the built-in token. Repository/account policies may require owner configuration.

## Run a published release locally

Requirements: Docker Desktop in Linux-container mode, Docker Compose 2.24.4+
(`!reset` removes build sections), and Node.js 22+. No application source or
`npm install` is needed when using the extracted bundle.

For a private package, authenticate locally with a GitHub personal access token
(classic) limited to `read:packages` and access to these packages:

```powershell
docker login ghcr.io -u ShafeekSaleem
```

Paste the token only at Docker's password prompt. Do not paste it in chat, put it
in a command argument, or commit it in an environment file. Docker Desktop stores
the login through its configured credential helper. Use `docker logout ghcr.io`
when access is no longer needed.

From the extracted bundle or the Phase 6 repository root:

```powershell
# New folder only. Preserve this file if you already have local settings.
Copy-Item .env.docker.example .env.docker
# Use release.env from the verified artifact, not .env.images.example placeholders.
Copy-Item release.env .env.images

npm run docker:images:config
npm run docker:images:pull
npm run docker:images:up
npm run docker:images:check
npm run docker:images:ps
```

The repository checkout does not contain `release.env`; copy it from the verified
bundle first. The bundle has a minimal package.json with the image helper commands.

`pull` downloads images and validates their revision labels. `up` pulls first,
then stops existing web/API containers before applying migrations and starting
the new stack. This causes a short local outage and prevents old API code serving
requests during migration. It never resets or seeds data. `check` verifies the
image revision, container health and web → API → database request path.

The two Compose files share the existing `pharmaceylon` project and named volumes.
Source-built and registry modes are alternatives, not two parallel stacks.
Do not change the project name to switch modes, or your existing data will appear
missing. Preserve your chosen database host port (`5432` or `5433`).

```powershell
npm run docker:images:logs
npm run docker:images:down
```

`down` preserves database and uploads. Never add `--volumes` to routine operations.

## Portable browser URLs

Published web images always build with `NEXT_PUBLIC_API_BASE_URL=/api/v1`.
The browser resolves this against its current origin, so the same image works
on localhost:3000, localhost:3002, or a future domain. Set `WEB_PORT` and
`WEB_ORIGINS` consistently in `.env.docker`. The published image ignores your
old local `NEXT_PUBLIC_API_BASE_URL` value because its bundle is already built.

Next's internal rewrite target remains `http://api:3001`. The NMRA confirm Route
Handler receives the same runtime target. Host development can keep its existing
absolute browser URL and host API target. This phase does not add server-side
authenticated data fetching to the shared browser API helper.

## Dependency remediation included in this phase

The first scan found fixable vulnerabilities in existing dependencies. Remediation
includes Next.js 15.5.24, bcrypt 6, sharp 0.35, SheetJS CE 0.20.3 from its official
distribution URL, and refreshed transitive dependency locks. The API and web
runtime images no longer ship npm/Yarn. The migrator calls the installed Prisma
CLI directly and also excludes global package managers.

Targeted root overrides address pinned upstream dependencies: Prisma config's
`deepmerge-ts`, Nest's `multer`/`js-yaml`, and Next's `postcss`/`sharp`. Remove these overrides
only when upstream constraints include fixed versions. The deepmerge-ts 8 change
affects Map-merging semantics; this app's Prisma config uses plain configuration
objects, and CI reruns migration/config loading plus the real RLS proofs. The
Prisma major version and database schema are unchanged.

CI additionally exercises real bcrypt hashing/comparison, an XLSX workbook
round-trip, and sharp resizing in the API image. Native package and parser updates
still warrant local login, uploads, and NMRA import tests before release approval.
The official SheetJS URL and integrity are pinned in the npm lockfile; this avoids
the outdated npm-registry `xlsx` release without changing import names.

## Updating and rollback

Keep each release's `release.env` and `release.json` together. Before updating,
back up the database and uploads and read migration changes. Replace `.env.images`
with the new verified release lock, then run `docker:images:up` and test login,
checkout, inventory, reports and imports with local test data.

Application rollback means restoring the previous complete `.env.images` and
starting those images. It is safe only when the database schema remains compatible.
`prisma migrate deploy` does not undo migrations, and pulling an older image does
not restore database or uploaded data. Destructive schema changes require a tested
backup/restore or forward-fix plan. Production rollback remains a later phase.

To return to source builds, stop the image stack and run the repository's
`npm run docker:up`. Named volumes remain in place. Avoid mixing migrator and
application releases independently.

## Retention and limits

Tested-image handoff archives expire after one day; security reports after seven
days; verified release bundles after thirty days. Save release locks you need
for longer. Registry packages are not automatically deleted: retain known-good
rollback versions and review account usage before setting a cleanup policy.
Never prune packages solely by age without considering deployed digests.

HTTPS, production secrets/cookies, restricted DB roles, RLS activation, backups,
shared upload storage and live environment monitoring are still required before
deployment. No paid server is needed for Phase 6 itself; account usage limits
and billing still apply.

Sources: [GitHub image publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images),
[GHCR access and digests](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[Compose merge/reset](https://docs.docker.com/reference/compose-file/merge/),
[Next.js environment variables](https://nextjs.org/docs/pages/guides/environment-variables),
[Trivy filtering](https://trivy.dev/docs/latest/configuration/filtering/).
