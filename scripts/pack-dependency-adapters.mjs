import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
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
