import { getIntakeQueue } from "./services/intake-queue";
import { getSaveQueue } from "./services/save-queue";
import {
  isCloudConfigured,
  isDemoDeployment,
  RUNTIME_CONFIG,
} from "./config/runtime";
import { createDataService, type DataService } from "./services/data-service";

const resolveDataMode = (): IAppOption["globalData"]["mode"] => {
  if (isCloudConfigured()) return "cloud";
  return isDemoDeployment() ? "local" : "blocked";
};

let syncTimer: ReturnType<typeof setTimeout> | undefined;
let appVisible = false;
const continueSync = (service: DataService) => {
  if (syncTimer) clearTimeout(syncTimer);
  if (!appVisible) return;
  syncTimer = setTimeout(() => {
    if (!appVisible) return;
    void getSaveQueue(service)
      .resume()
      .then(() => getIntakeQueue(service).resume())
      .catch(() => undefined)
      .finally(() => continueSync(service));
  }, 15_000);
};

App<IAppOption>({
  globalData: {
    service: null,
    mode: resolveDataMode(),
  },

  onLaunch() {
    if (isCloudConfigured() && wx.cloud) {
      wx.cloud.init({ env: RUNTIME_CONFIG.cloudEnvId, traceUser: false });
    }
    if (this.globalData.mode !== "blocked") {
      this.globalData.service = createDataService(this.globalData.mode);
    }
    wx.onNetworkStatusChange?.(({ isConnected }) => {
      if (isConnected && this.globalData.mode === "cloud") {
        const service = this.getService();
        void service
          .bootstrap()
          .then(async () => {
            await getSaveQueue(service).resume();
            await getIntakeQueue(service).resume();
          })
          .catch(() => undefined);
      }
    });
  },

  onHide() {
    appVisible = false;
    if (syncTimer) clearTimeout(syncTimer);
  },

  onShow() {
    appVisible = true;
    if (this.globalData.mode === "cloud") {
      const service = this.getService();
      continueSync(service);
      void service
        .bootstrap()
        .then(async () => {
          await getSaveQueue(service).resume();
          await getIntakeQueue(service).resume();
        })
        .catch(() => undefined);
    }
  },

  getService(): DataService {
    if (this.globalData.mode === "blocked") {
      throw new Error("正式环境尚未配置云服务，已阻止使用本机存储");
    }
    if (!this.globalData.service) {
      this.globalData.service = createDataService(this.globalData.mode);
    }
    return this.globalData.service;
  },
});
