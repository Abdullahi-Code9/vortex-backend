/** @type {import('jest').Config} */
module.exports = {
  // Run both the main NestJS unit suite and the scripts suite under one command.
  projects: [
    // ── Main NestJS unit suite ──────────────────────────────────────────────
    {
      displayName: "src",
      preset: "ts-jest",
      testEnvironment: "node",
      rootDir: "src",
      testRegex: ".*\\.spec\\.ts$",
      // Exclude the scripts sub-suite so tests aren't picked up twice.
      testPathIgnorePatterns: ["/scripts/"],
      collectCoverageFrom: ["**/*.(t|j)s"],
    },

    // ── Scripts suite (ledger-utils, etc.) ─────────────────────────────────
    // Tests live in src/scripts/ but import from scripts/ (outside src/).
    // A dedicated tsconfig with broader rootDir handles the path.
    {
      displayName: "scripts",
      testEnvironment: "node",
      rootDir: ".",
      testMatch: ["<rootDir>/src/scripts/**/*.spec.ts"],
      transform: {
        "^.+\\.tsx?$": [
          "ts-jest",
          {
            tsconfig: "./tsconfig.scripts.json",
          },
        ],
      },
    },
  ],

  // Coverage is collected from the project-level collectCoverageFrom above.
  coverageDirectory: "coverage",
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};
