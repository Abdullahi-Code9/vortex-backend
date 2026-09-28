/** @type {import('jest').Config} */

// The single definition of the coverage gate. It is enforced on the *merged*
// shard report by scripts/ci/coverage-merge.mjs, not by individual shard runs
// (issue #486), which pass --coverageThreshold '{}' because a shard only ever
// executes part of the suite.
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  collectCoverageFrom: ["**/*.(t|j)s"],
  coverageDirectory: "../coverage",
  // text-summary keeps local runs readable, lcov feeds editors, and json is what
  // coverage-merge.mjs consumes.
  coverageReporters: ["text-summary", "lcov", "json"],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};
