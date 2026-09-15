import { access, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const bundleRoot = path.join(projectRoot, "dist", "miniprogram");
const maxBundleBytes = 2 * 1024 * 1024;

const fail = (message) => {
  throw new Error(`BUNDLE_SIZE_INVALID: ${message}`);
};

await access(path.join(bundleRoot, "app.json")).catch(() =>
  fail("缺少 dist/miniprogram/app.json；请先运行 npm run build"),
);

const files = [];
const collectFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolutePath);
      continue;
    }
    if (!entry.isFile())
      fail(`构建产物含非普通文件：${path.relative(projectRoot, absolutePath)}`);

    const { size } = await lstat(absolutePath);
    files.push({
      relativePath: path.relative(bundleRoot, absolutePath),
      size,
    });
  }
};

await collectFiles(bundleRoot);
if (files.length === 0) fail("构建产物为空");

const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
if (totalBytes > maxBundleBytes) {
  const largestFiles = [...files]
    .sort((left, right) => right.size - left.size)
    .slice(0, 5)
    .map((file) => `${file.relativePath} (${file.size} bytes)`)
    .join(", ");
  fail(
    `dist/miniprogram 共 ${totalBytes} bytes，超过 ${maxBundleBytes} bytes 上限；最大文件：${largestFiles}`,
  );
}

const usedMiB = (totalBytes / 1024 / 1024).toFixed(3);
const remainingKiB = ((maxBundleBytes - totalBytes) / 1024).toFixed(1);
console.log(
  `[release] bundle size ok: ${files.length} files, ${usedMiB} MiB used, ${remainingKiB} KiB remaining`,
);
