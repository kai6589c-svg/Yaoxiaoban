// A standalone built project avoids stale nested-root caches in Nightly DevTools.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "dist/wechat-preview");
await mkdir(destination, { recursive: true });
await cp(path.join(root, "dist/miniprogram"), destination, { recursive: true });
const config = JSON.parse(
  await readFile(path.join(root, "project.config.json"), "utf8"),
);
config.miniprogramRoot = "./";
delete config.cloudfunctionRoot;
config.projectname = "yaoxiaoban-beta18-preview";
await writeFile(
  path.join(destination, "project.config.json"),
  JSON.stringify(config, null, 2) + "\n",
);
console.log(`Prepared standalone production preview: ${destination}`);
