"use strict";

const cloud = require("wx-server-sdk");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("./lib/config");
const { ReminderStore } = require("./lib/store");
const { ReminderWorker } = require("./lib/worker");

const config = loadConfig();
cloud.init({ env: config.environmentId || cloud.DYNAMIC_CURRENT_ENV });

const store = new ReminderStore(cloud.database());
const sender = {
  send: (message) => cloud.openapi.subscribeMessage.send(message),
};
const worker = new ReminderWorker({ store, sender, config, logger: console });

exports.main = async (event = {}) => {
  if (event.action === "health") {
    return {
      ok: true,
      functionName: "reminder-worker",
      buildId: readBuildId(),
    };
  }
  const runtime = cloud.getWXContext();
  return worker.run({
    limit: event.limit,
    runtimeEnvironmentId: runtime?.ENV ?? null,
  });
};

function readBuildId() {
  try {
    return fs.readFileSync(path.join(__dirname, "BUILD_ID"), "utf8").trim();
  } catch {
    return process.env.BUILD_ID ?? "source";
  }
}
