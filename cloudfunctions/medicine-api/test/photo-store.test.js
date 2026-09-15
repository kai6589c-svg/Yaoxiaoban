"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CloudStore } = require("../lib/store");

// CloudBase expands a plain object in update() into dotted child updates.
// Unlike the domain MemoryStore, that cannot add children beneath photo:null.
// command.set(value) replaces the whole field and also removes stale children.
function databaseFixture(photo) {
  const document = {
    _id: "med-photo",
    accountId: "account-photo",
    version: 1,
    photo,
    name: "Unchanged fixture",
  };
  const filters = [];
  class Command {
    constructor(kind, value) {
      this.kind = kind;
      this.value = value;
    }
  }
  function apply(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value instanceof Command) {
        target[key] =
          value.kind === "inc" ? target[key] + value.value : value.value;
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        if (target[key] === null) {
          throw new Error("Cannot create field in element {photo: null}");
        }
        target[key] ??= {};
        apply(target[key], value);
      } else {
        target[key] = value;
      }
    }
  }
  const db = {
    command: {
      inc: (value) => new Command("inc", value),
      set: (value) => new Command("set", value),
    },
    collection(name) {
      assert.equal(name, "yxb_medications");
      return {
        where(filter) {
          filters.push(filter);
          return {
            async update({ data }) {
              if (
                !Object.entries(filter).every(
                  ([key, value]) => document[key] === value,
                )
              )
                return { stats: { updated: 0 } };
              apply(document, data);
              return { stats: { updated: 1 } };
            },
          };
        },
      };
    },
  };
  const store = new CloudStore(db);
  store.assertAccountActive = async () => ({ status: "active" });
  store.getOwned = async () => structuredClone(document);
  const update = (photoValue, version = document.version) =>
    store.updateOwnedVersioned(
      "medications",
      document._id,
      document.accountId,
      version,
      { photo: photoValue },
      "2026-09-05T00:00:00.000Z",
      `request-${version}`,
    );
  return { document, filters, update };
}

const PHOTO = {
  mediaId: "media-new",
  fileId: "cloud://env/new.jpg",
  updatedAt: "2026-09-05",
};

test("首次照片能从 null 整体写入，保留药盒资料和版本所有权条件", async () => {
  const fixture = databaseFixture(null);
  const result = await fixture.update(PHOTO);
  assert.deepEqual(result.photo, PHOTO);
  assert.equal(result.name, "Unchanged fixture");
  assert.equal(result.version, 2);
  assert.deepEqual(fixture.filters, [
    { _id: "med-photo", accountId: "account-photo", version: 1 },
  ]);
});

test("更换照片整体替换引用，不残留旧对象的子字段", async () => {
  const fixture = databaseFixture({ ...PHOTO, legacyPath: "old-value" });
  const result = await fixture.update({
    ...PHOTO,
    fileId: "cloud://env/replacement.jpg",
  });
  assert.deepEqual(result.photo, {
    ...PHOTO,
    fileId: "cloud://env/replacement.jpg",
  });
});

test("移除照片后可再次添加", async () => {
  const fixture = databaseFixture(PHOTO);
  assert.equal((await fixture.update(null)).photo, null);
  assert.deepEqual((await fixture.update(PHOTO)).photo, PHOTO);
  assert.equal(fixture.document.version, 3);
});

test("过时的照片版本仍拒绝写入", async () => {
  const fixture = databaseFixture(null);
  await assert.rejects(
    () => fixture.update(PHOTO, 0),
    (error) => error.code === "VERSION_CONFLICT",
  );
  assert.equal(fixture.document.photo, null);
  assert.equal(fixture.document.version, 1);
});
