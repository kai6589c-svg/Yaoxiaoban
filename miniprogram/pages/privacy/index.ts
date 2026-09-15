import { RUNTIME_CONFIG } from "../../config/runtime";

Page({
  data: {
    version: RUNTIME_CONFIG.privacyVersion,
    effectiveDate: "2026年9月3日",
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      void wx.navigateBack();
      return;
    }
    void wx.reLaunch({ url: "/pages/start/index" });
  },
});
