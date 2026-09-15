import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
for (const method of ["set", "unset"]) {
  const file = `yaoxiaoban-lodash-${method}-compat-1.0.0.tgz`;
  execFileSync(
    "npm",
    [
      "pack",
      `./cloudfunctions/dependency-adapters/lodash-${method}`,
      "--pack-destination",
      "./cloudfunctions/medicine-api",
    ],
    { stdio: "ignore" },
  );
  for (const name of ["reminder-worker", "maintenance-worker"])
    copyFileSync(
      `cloudfunctions/medicine-api/${file}`,
      `cloudfunctions/${name}/${file}`,
    );
}

// Lock the exact bytes we publish; a warm npm cache can otherwise mask stale
// integrity values until a fresh machine installs these local tarballs.
for (const name of ["medicine-api", "reminder-worker", "maintenance-worker"]) {
  const directory = `cloudfunctions/${name}`;
  const lockPath = `${directory}/package-lock.json`;
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  for (const item of Object.values(lock.packages)) {
    if (item.resolved?.startsWith("file:") && item.resolved.endsWith(".tgz")) {
      const bytes = readFileSync(`${directory}/${item.resolved.slice(5)}`);
      item.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    }
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}
