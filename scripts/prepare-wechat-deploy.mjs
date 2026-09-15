// Nightly deployment mishandles nested directories and local npm tarballs.
// Bundle the audited SDK and adapters too: deployment needs no remote install.
import { mkdir, copyFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["medicine-api", "maintenance-worker", "reminder-worker"]) {
  const source = path.join(root, "dist/cloudfunctions", name);
  const destination = path.join(root, "dist/wechat-deploy", name);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await build({
    entryPoints: [path.join(source, "index.js")],
    bundle: true,
    platform: "node",
    target: "node16",
    outfile: path.join(destination, "index.js"),
  });
  for (const file of ["config.json", "BUILD_ID"]) {
    await copyFile(path.join(source, file), path.join(destination, file));
  }
  await writeFile(
    path.join(destination, "package.json"),
    JSON.stringify(
      {
        name: `yaoxiaoban-${name}`,
        version: "1.0.0",
        private: true,
        main: "index.js",
        dependencies: {},
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Prepared self-contained WeChat deployment: ${name}`);
}
