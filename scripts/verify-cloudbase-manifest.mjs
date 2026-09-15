import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const { COLLECTIONS } = require(
  path.join(projectRoot, "cloudfunctions/medicine-api/lib/constants.js"),
);
const manifest = JSON.parse(
  await readFile(
    path.join(projectRoot, "docs/cloudbase-database-manifest.json"),
    "utf8",
  ),
);

const fail = (message) => {
  throw new Error(`CLOUDBASE_MANIFEST_INVALID: ${message}`);
};

if (manifest.schemaVersion !== 1) fail("schemaVersion 必须为 1");
if (manifest.collectionPrefix !== "yxb_") fail("集合前缀必须为 yxb_");
if (manifest.clientRule?.read !== false || manifest.clientRule?.write !== false)
  fail("客户端 read/write 必须同时为 false");

const expected = Object.values(COLLECTIONS).sort();
const actual = manifest.collections
  .map((collection) => collection.logicalName)
  .sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  fail(`集合与服务端常量不一致；期望 ${expected.join(", ")}`);
}

const seenCollections = new Set();
for (const collection of manifest.collections) {
  if (seenCollections.has(collection.name))
    fail(`集合名重复：${collection.name}`);
  seenCollections.add(collection.name);
  if (collection.name !== `yxb_${collection.logicalName}`)
    fail(`集合物理名错误：${collection.name}`);
  if (!Array.isArray(collection.indexes))
    fail(`${collection.name} 缺少 indexes 数组`);

  const seenIndexes = new Set();
  for (const index of collection.indexes) {
    if (seenIndexes.has(index.name))
      fail(`${collection.name} 索引名重复：${index.name}`);
    seenIndexes.add(index.name);
    if (!Array.isArray(index.fields) || index.fields.length < 2)
      fail(`${collection.name}.${index.name} 必须是至少双字段复合索引`);
    const fieldNames = new Set();
    for (const field of index.fields) {
      if (!field.field || fieldNames.has(field.field))
        fail(`${collection.name}.${index.name} 含空字段或重复字段`);
      fieldNames.add(field.field);
      if (!["asc", "desc"].includes(field.order))
        fail(`${collection.name}.${index.name}.${field.field} 排序无效`);
    }
  }
}

const ownedCollections = [
  "profiles",
  "medications",
  "plans",
  "snapshots",
  "intake_logs",
  "settings",
  "calendar_exports",
  "idempotency",
  "reminder_tasks",
  "media",
  "subscription_grants",
];
for (const logicalName of ownedCollections) {
  const collection = manifest.collections.find(
    (candidate) => candidate.logicalName === logicalName,
  );
  const hasBaseIndex = collection.indexes.some(
    (index) =>
      index.fields.length === 2 &&
      index.fields[0].field === "accountId" &&
      index.fields[0].order === "asc" &&
      index.fields[1].field === "_id" &&
      index.fields[1].order === "asc",
  );
  if (!hasBaseIndex) fail(`${collection.name} 缺少 accountId ASC, _id ASC`);
}

console.log(
  `[cloudbase] manifest ok: ${manifest.collections.length} collections, ${manifest.collections.reduce((sum, item) => sum + item.indexes.length, 0)} indexes, client read/write disabled`,
);
