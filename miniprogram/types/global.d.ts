import type { DataService } from "../services/data-service";

declare global {
  interface IAppOption {
    globalData: {
      service: DataService | null;
      mode: "local" | "cloud" | "blocked";
    };
    getService(): DataService;
  }
}

export {};
