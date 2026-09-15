import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "cloudfunctions");
const outputRoot = path.join(root, "dist", "cloudfunctions");
const stagingRoot = path.join(root, "dist", ".cloudfunctions-staging");
const backupRoot = path.join(root, "dist", ".cloudfunctions-backup");
const functionNames = ["medicine-api", "reminder-worker", "maintenance-worker"];

// Never remove the last deployable package before a new package is complete.
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });

async function copyRuntime(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (
      entry.name === "test" ||
      entry.name === "README.md" ||
      entry.name === "node_modules"
    )
      continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyRuntime(from, to);
    else await cp(from, to);
  }
}

for (const name of functionNames) {
  const source = path.join(sourceRoot, name);
  const destination = path.join(stagingRoot, name);
  await copyRuntime(source, destination);
  if (name === "maintenance-worker") {
    // The maintenance function receives its own copy of the API modules.
    // It must remain loadable when the medicine-api source directory is absent.
    await copyRuntime(
      path.join(sourceRoot, "medicine-api", "lib"),
      path.join(destination, "lib", "medicine-api"),
    );
    const indexPath = path.join(destination, "index.js");
    const index = await readFile(indexPath, "utf8");
    await writeFile(
      indexPath,
      index.replaceAll("../medicine-api/lib/", "./lib/medicine-api/"),
    );
  }
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
    cwd: destination,
    stdio: "inherit",
  });
}

const hash = createHash("sha256");
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  functions: {},
};
for (const name of functionNames) {
  const directory = path.join(stagingRoot, name);
  const files = [];
  async function collect(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules")
        await collect(full);
      else if (entry.isFile() && entry.name !== "package-lock.json")
        files.push(full);
    }
  }
  await collect(directory);
  files.sort();
  const fileHashes = [];
  for (const file of files) {
    const content = await readFile(file);
    const fileHash = createHash("sha256").update(content).digest("hex");
    hash.update(path.relative(stagingRoot, file)).update(fileHash);
    fileHashes.push({ path: path.relative(directory, file), sha256: fileHash });
  }
  const lockContent = await readFile(path.join(directory, "package-lock.json"));
  const dependencyLockSha256 = createHash("sha256")
    .update(lockContent)
    .digest("hex");
  const buildId = `cf-${createHash("sha256")
    .update(
      `${name}:${fileHashes.map((item) => item.sha256).join("")}:${dependencyLockSha256}:${manifest.generatedAt}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 16)}`;
  await writeFile(path.join(directory, "BUILD_ID"), `${buildId}\n`);
  manifest.functions[name] = {
    buildId,
    dependencyLockSha256,
    files: fileHashes,
  };
}
manifest.sha256 = hash.digest("hex");
await writeFile(
  path.join(stagingRoot, "BUILD_MANIFEST.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
// Swap directories through a same-filesystem backup. This works on macOS too,
// where renaming a directory over a non-empty directory fails with ENOTEMPTY.
// If the final switch fails, restore the previous complete package.
await rm(backupRoot, { recursive: true, force: true });
let movedPrevious = false;
try {
  await rename(outputRoot, backupRoot);
  movedPrevious = true;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
try {
  await rename(stagingRoot, outputRoot);
} catch (error) {
  if (movedPrevious) await rename(backupRoot, outputRoot);
  throw error;
}
await rm(backupRoot, { recursive: true, force: true });
console.log(`Built independent CloudBase function packages at ${outputRoot}`);
