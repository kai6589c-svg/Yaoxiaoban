"use strict";

const cloud = require("wx-server-sdk");
const fs = require("node:fs");
const path = require("node:path");
const { CompatibilityService } = require("./lib/compat-service");
const { createApiHandler } = require("./lib/handler");
const { MedicineService } = require("./lib/service");
const { PhotoStorage } = require("./lib/photo-storage");
const { CloudStore } = require("./lib/store");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const photoStorage = new PhotoStorage(cloud);
const store = new CloudStore(cloud.database(), { photoStorage });
const service = new MedicineService(store, { logger: console, photoStorage });
const compatibilityService = new CompatibilityService(store, service);
const handler = createApiHandler({
  store,
  service,
  compatibilityService,
  getIdentity: async () => cloud.getWXContext(),
  logger: console,
});

exports.main = async (event = {}) => {
  if (event.action === "health") {
    return {
      ok: true,
      functionName: "medicine-api",
      buildId: readBuildId(),
    };
  }
  return handler(event);
};

function readBuildId() {
  try {
    return fs.readFileSync(path.join(__dirname, "BUILD_ID"), "utf8").trim();
  } catch {
    return process.env.BUILD_ID ?? "source";
  }
}
