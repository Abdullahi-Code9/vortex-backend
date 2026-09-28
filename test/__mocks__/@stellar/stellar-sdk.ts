import * as path from "path";

// The e2e moduleNameMapper maps the bare specifier "^@stellar/stellar-sdk$" to
// this file (jest.requireActual still goes through moduleNameMapper, so it
// cannot be used here). Resolve the real package entry by absolute path
// instead — an absolute path does not match the mapper regex, so the genuine
// SDK is loaded and re-exported below (only SorobanRpc.Server is replaced).
/* eslint-disable @typescript-eslint/no-var-requires */
const actual = require(path.resolve(
  __dirname,
  "../../../node_modules/@stellar/stellar-sdk/lib/index.js",
)) as typeof import("@stellar/stellar-sdk");
/* eslint-enable @typescript-eslint/no-var-requires */

const mockServer = {
  getHealth: jest.fn().mockResolvedValue({ status: "ok" }),
  getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1 }),
  getNetwork: jest.fn().mockResolvedValue({ passphrase: "test" }),
  getAccount: jest.fn().mockResolvedValue({ id: "test", sequence: "0" }),
};

const mockServerClass = jest.fn().mockImplementation(() => mockServer);

module.exports = {
  ...actual,
  SorobanRpc: {
    ...actual.SorobanRpc,
    Server: mockServerClass,
  },
  rpc: {
    ...actual.rpc,
    Server: mockServerClass,
  },
};
