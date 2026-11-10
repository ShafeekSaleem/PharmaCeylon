// Renderer date copy (en-GB) must match CI and late zones such as Pacific/Auckland.
process.env.TZ = "UTC";

/** @type {import("jest").Config} */
const config = {
  moduleFileExtensions: ["js", "json", "ts", "tsx"],
  rootDir: ".",
  // Main-process specs run in Node. Renderer specs (*.spec.tsx, and keymap.spec.ts) opt into
  // jsdom with a `@jest-environment jsdom` docblock.
  testEnvironment: "node",
  testRegex: "src/.*\.spec\.tsx?$",
  transform: {
    "^.+\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node10",
          esModuleInterop: true,
          isolatedModules: true,
          jsx: "react-jsx",
        },
      },
    ],
  },
  // CSS modules come back as their class names, so a test can still find `styles.foo`.
  moduleNameMapper: { "\.css$": "<rootDir>/src/renderer/test/css-module.cjs" },
};

module.exports = config;
