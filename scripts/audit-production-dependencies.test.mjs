import test from "node:test";
import assert from "node:assert/strict";
import {
  runAllAudits,
  summarizeAudit,
} from "./audit-production-dependencies.mjs";

test("audit gate fails when any isolated function has a high vulnerability", () => {
  const results = runAllAudits(
    [
      { name: "root", cwd: "." },
      { name: "medicine-api", cwd: "functions/medicine-api" },
    ],
    (_command, args) => ({
      status: args.includes("--audit-level=high") ? 1 : 0,
      stdout: JSON.stringify({
        metadata: {
          vulnerabilities: {
            critical: 0,
            high: 2,
            moderate: 0,
            low: 0,
            total: 2,
          },
        },
      }),
      stderr: "",
    }),
  );
  assert.equal(
    results.every((result) => result.ok),
    false,
  );
  assert.equal(results[1].high, 2);
});

test("audit gate fails closed on a network or malformed audit response", () => {
  const summary = summarizeAudit({
    status: null,
    stdout: "",
    stderr: "network down",
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.error, "AUDIT_OUTPUT_NOT_JSON");
});

test("audit gate accepts a clean production report", () => {
  const summary = summarizeAudit({
    status: 0,
    stdout: JSON.stringify({
      metadata: {
        vulnerabilities: {
          critical: 0,
          high: 0,
          moderate: 0,
          low: 0,
          total: 0,
        },
      },
    }),
    stderr: "",
  });
  assert.equal(summary.ok, true);
});
