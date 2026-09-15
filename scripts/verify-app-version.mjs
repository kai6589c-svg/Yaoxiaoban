import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const fail = (message) => {
  throw new Error(`APP_VERSION_INVALID: ${message}`);
};

const readText = (relativePath) =>
  readFile(path.join(projectRoot, relativePath), "utf8");
const readJson = async (relativePath) =>
  JSON.parse(await readText(relativePath));

const packageManifest = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const versionSource = await readText("miniprogram/config/version.ts");
const versionBuild = await readText("dist/miniprogram/config/version.js").catch(
  () => fail("缺少构建产物；请先运行 npm run build"),
);

const sourceMatch = versionSource.match(
  /export\s+const\s+APP_VERSION\s*=\s*(["'])([^"']+)\1\s+as\s+const\s*;/,
);
if (!sourceMatch) fail("miniprogram/config/version.ts 未定义静态 APP_VERSION");

const buildMatch = versionBuild.match(
  /exports\.APP_VERSION\s*=\s*(["'])([^"']+)\1\s*;/,
);
if (!buildMatch) fail("构建产物未导出静态 APP_VERSION");

const appVersion = sourceMatch[2];
const builtVersion = buildMatch[2];
const packageVersion = packageManifest.version;
const lockVersion = packageLock.version;
const lockedRootVersion = packageLock.packages?.[""]?.version;

if (typeof packageVersion !== "string" || packageVersion.length === 0)
  fail("package.json 缺少 version");
if (appVersion !== packageVersion)
  fail(`APP_VERSION ${appVersion} 与 package.json ${packageVersion} 不一致`);
if (builtVersion !== appVersion)
  fail(`构建产物 ${builtVersion} 与源码 ${appVersion} 不一致`);
if (lockVersion !== packageVersion || lockedRootVersion !== packageVersion)
  fail("package-lock.json 与 package.json 版本不一致");

console.log(`[release] app version ok: ${appVersion}`);
