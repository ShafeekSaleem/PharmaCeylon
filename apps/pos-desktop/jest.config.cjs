/** @type {import("jest").Config} */
const config = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testEnvironment: "node",
  testRegex: "src/.*\.spec\.ts$",
  transform: {
    "^.+\.ts$": [
      "ts-jest",
      { tsconfig: { module: "commonjs", moduleResolution: "node10", esModuleInterop: true, isolatedModules: true } },
    ],
  },
};

module.exports = config;
