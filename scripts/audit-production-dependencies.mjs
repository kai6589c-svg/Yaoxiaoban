import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  { name: "root", cwd: root },
  { name: "medicine-api", cwd: path.join(root, "cloudfunctions/medicine-api") },
  {
    name: "reminder-worker",
    cwd: path.join(root, "cloudfunctions/reminder-worker"),
  },
  {
    name: "maintenance-worker",
    cwd: path.join(root, "cloudfunctions/maintenance-worker"),
  },
];

export function summarizeAudit({ status, stdout, stderr }) {
  if (!stdout || !String(stdout).trim()) {
    return {
      ok: false,
      error: "AUDIT_OUTPUT_NOT_JSON",
      status,
      stderr: String(stderr || "").slice(-2000),
    };
  }
  let report;
  try {
    report = JSON.parse(stdout || "{}");
  } catch {
    return {
      ok: false,
      error: "AUDIT_OUTPUT_NOT_JSON",
      status,
      stderr: String(stderr || "").slice(-2000),
    };
  }
  const metadata = report.metadata?.vulnerabilities ?? {};
  const high = Number(metadata.high ?? 0);
  const critical = Number(metadata.critical ?? 0);
  const auditError = report.error?.code || report.error?.summary;
  return {
    ok: !auditError && status === 0 && high === 0 && critical === 0,
    status,
    high,
    critical,
    moderate: Number(metadata.moderate ?? 0),
    low: Number(metadata.low ?? 0),
    total: Number(metadata.total ?? 0),
    error: auditError ?? null,
  };
}

export function runAudit(target, runner = spawnSync) {
  const result = runner(
    "npm",
    ["audit", "--json", "--omit=dev", "--audit-level=high"],
    { cwd: target.cwd, encoding: "utf8" },
  );
  const summary = summarizeAudit({
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  return { ...target, ...summary };
}

export function runAllAudits(targetList = targets, runner = spawnSync) {
  return targetList.map((target) => runAudit(target, runner));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = runAllAudits();
  for (const result of results) {
    const counts = result.error
      ? `error=${result.error}`
      : `critical=${result.critical} high=${result.high} moderate=${result.moderate} low=${result.low} total=${result.total}`;
    console.log(
      `[security:audit] ${result.name}: ${result.ok ? "PASS" : "FAIL"} ${counts}`,
    );
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}
