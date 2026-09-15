import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repositoryRoot, "miniprogram");
const outputRoot = join(repositoryRoot, "dist", "miniprogram");
const stagingRoot = join(repositoryRoot, "dist", ".miniprogram-staging");
const tscPath = join(repositoryRoot, "node_modules", ".bin", "tsc");

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });

try {
  execFileSync(
    process.env.MINIPROGRAM_TSC_PATH || tscPath,
    [
      "-p",
      join(repositoryRoot, "tsconfig.build.json"),
      "--outDir",
      stagingRoot,
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );

  const copyRuntimeAssets = async (sourceDirectory, outputDirectory) => {
    await mkdir(outputDirectory, { recursive: true });
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(sourceDirectory, entry.name);
      const outputPath = join(outputDirectory, entry.name);
      if (entry.isDirectory()) {
        await copyRuntimeAssets(sourcePath, outputPath);
      } else if (extname(entry.name) !== ".ts") {
        await cp(sourcePath, outputPath);
      }
    }
  };

  await copyRuntimeAssets(sourceRoot, stagingRoot);
  await verifyBuiltEntry(stagingRoot);

  // Keep the last complete package in place until the next package is ready.
  // Copying the completed tree preserves app.json during watcher observation.
  await mkdir(outputRoot, { recursive: true });
  await syncCompletedTree(stagingRoot, outputRoot);
  await rm(stagingRoot, { recursive: true, force: true });
  console.log(`Built WeChat mini program at ${outputRoot}`);
} catch (error) {
  await rm(stagingRoot, { recursive: true, force: true });
  throw error;
}

async function verifyBuiltEntry(root) {
  const appJson = join(root, "app.json");
  const app = JSON.parse(await readFile(appJson, "utf8"));
  if (!app.pages?.length)
    throw new Error("BUILD_INVALID: app.json pages missing");
}

async function syncCompletedTree(sourceDirectory, outputDirectory) {
  const sourceEntries = await readdir(sourceDirectory, { withFileTypes: true });
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
  const outputEntries = await readdir(outputDirectory, { withFileTypes: true });
  for (const entry of outputEntries) {
    if (!sourceNames.has(entry.name))
      await rm(join(outputDirectory, entry.name), {
        recursive: true,
        force: true,
      });
  }
  for (const entry of sourceEntries) {
    const sourcePath = join(sourceDirectory, entry.name);
    const outputPath = join(outputDirectory, entry.name);
    if (entry.isDirectory()) {
      await mkdir(outputPath, { recursive: true });
      await syncCompletedTree(sourcePath, outputPath);
    } else {
      await cp(sourcePath, outputPath);
    }
  }
}
