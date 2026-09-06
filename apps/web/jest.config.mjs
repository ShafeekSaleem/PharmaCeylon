import nextJest from "next/jest.js";

/**
 * UI tests for the web app.
 *
 * `next/jest` is what makes this work without a hand-rolled Babel/SWC setup: it wires up the
 * project's own TypeScript and CSS-module handling, so a component under test resolves
 * `@/components/...` and `styles.foo` exactly as it does in the app.
 *
 * Plain ESM rather than a `.ts` config: Jest needs `ts-node` to read a TypeScript config, and
 * pulling in a second TypeScript runtime to configure the first one is not worth it.
 */
const createJestConfig = nextJest({ dir: "./" });

export default createJestConfig({
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testMatch: ["<rootDir>/src/**/*.spec.tsx", "<rootDir>/src/**/*.spec.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  clearMocks: true,
  // `.next/standalone` contains a copy of package.json, which Jest's module map reads as a
  // second package named "web". Harmless, but it warns on every run.
  modulePathIgnorePatterns: ["<rootDir>/.next/"],
});
