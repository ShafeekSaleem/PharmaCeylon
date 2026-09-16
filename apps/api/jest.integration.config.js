/**
 * Database-backed tests (`*.int-spec.ts`). They run against a throwaway database built from the
 * real migrations, because what they prove — row locks, concurrent stock moves, transactions
 * rolling back — can't be shown with a mocked Prisma client.
 *
 *   npm run test:integration -w api
 *
 * Needs a reachable PostgreSQL in DATABASE_URL; the suite creates (and recreates) a database
 * named `<your database>_it` next to it and never touches your own data.
 *
 * @type {import("jest").Config}
 */
const config = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testEnvironment: "node",
  testRegex: "test/integration/.*\\.int-spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": "ts-jest",
  },
  globalSetup: "<rootDir>/test/integration/global-setup.ts",
  // One database, shared fixtures per file: run files one after another.
  maxWorkers: 1,
  testTimeout: 60_000,
};

module.exports = config;
