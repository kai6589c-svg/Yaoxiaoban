"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const set = require("lodash.set");
const unset = require("lodash.unset");
test("patched SDK path adapters preserve nested object/array operations", () => {
  const target = {};
  assert.equal(set(target, "plans[0].dose", 2), target);
  assert.deepEqual(target, { plans: [{ dose: 2 }] });
  assert.equal(unset(target, ["plans", "0", "dose"]), true);
  assert.deepEqual(target.plans, [{}]);
});
test("path adapters cannot mutate Object.prototype through dangerous paths", () => {
  const key = "yxb_pollution_probe";
  try {
    set({}, ["__proto__", key], true);
    set({}, ["constructor", "prototype", key], true);
    assert.equal(Object.prototype[key], undefined);
    Object.prototype[key] = "preserved";
    unset({}, ["__proto__", key]);
    assert.equal(Object.prototype[key], "preserved");
  } finally {
    delete Object.prototype[key];
  }
});
test("cloud SDK still loads and constructs a database command with patched dependencies", () => {
  const cloud = require("wx-server-sdk");
  cloud.init({ env: "dependency-smoke-test" });
  assert.equal(typeof cloud.database().command.set, "function");
});
