"use strict";

const cloud = require("wx-server-sdk");
const fs = require("node:fs");
const path = require("node:path");
const { MaintenanceWorker } = require("./lib/worker");
const { MedicineService } = require("../medicine-api/lib/service");
const { PhotoStorage } = require("../medicine-api/lib/photo-storage");
const { CloudStore } = require("../medicine-api/lib/store");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const photoStorage = new PhotoStorage(cloud);
const store = new CloudStore(cloud.database(), { photoStorage });
const service = new MedicineService(store, { logger: console, photoStorage });
const worker = new MaintenanceWorker({ store, service, logger: console });

exports.main = async (event = {}) => {
  if (event.action === "health") {
    return {
      ok: true,
      functionName: "maintenance-worker",
      buildId: readBuildId(),
    };
  }
  // Maintenance is fail-closed in production. It can only be enabled by a
  // server-side environment setting after a bounded account-scope review;
  // client-supplied event flags never enable it.
  if (process.env.MAINTENANCE_ENABLED !== "true") {
    return {
      enabled: false,
      accounts: 0,
      mediaScanned: 0,
      deletionsCompleted: 0,
      failures: 0,
    };
  }
  return worker.run({ limit: event.limit });
};

function readBuildId() {
  try {
    return fs.readFileSync(path.join(__dirname, "BUILD_ID"), "utf8").trim();
  } catch {
    return process.env.BUILD_ID ?? "source";
  }
}
