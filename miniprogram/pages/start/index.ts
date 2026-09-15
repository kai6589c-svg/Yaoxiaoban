import { RUNTIME_CONFIG } from "../../config/runtime";
import { showError } from "../../services/ui";

interface StartPageData {
  loading: boolean;
  accepting: boolean;
  consentChecked: boolean;
  declined: boolean;
  loadFailed: boolean;
}

const initialData: StartPageData = {
  loading: true,
  accepting: false,
  consentChecked: false,
  declined: false,
  loadFailed: false,
};

Page({
  data: initialData,
  bootstrapAttempt: 0,

  onLoad() {
    void this.loadAccount();
  },

  async loadAccount() {
    const attempt = ++this.bootstrapAttempt;
    this.setData({ loading: true, loadFailed: false });
    try {
      const state = await getApp<IAppOption>().getService().bootstrap();
      if (attempt !== this.bootstrapAttempt) return;
      if (
        state.settings.privacyAcceptedVersion === RUNTIME_CONFIG.privacyVersion
      ) {
        void wx.switchTab({ url: "/pages/today/index" });
        return;
      }
      this.setData({ loading: false });
    } catch (error) {
      if (attempt !== this.bootstrapAttempt) return;
      this.setData({ loading: false, loadFailed: true });
      showError(error, "暂时无法启动，请稍后重试");
    }
  },

  onConsentChange(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) {
    this.setData({
      consentChecked: event.detail.value.includes("accepted"),
      declined: false,
    });
  },

  openPrivacy() {
    void wx.navigateTo({ url: "/pages/privacy/index" });
  },

  declinePrivacy() {
    this.setData({ consentChecked: false, declined: true });
  },

  reconsiderPrivacy() {
    this.setData({ declined: false });
  },

  async acceptPrivacy() {
    if (!this.data.consentChecked || this.data.accepting) return;
    this.setData({ accepting: true });
    void wx.showLoading({ title: "正在开启", mask: true });
    try {
      await getApp<IAppOption>()
        .getService()
        .acceptPrivacy(RUNTIME_CONFIG.privacyVersion);
      void wx.switchTab({ url: "/pages/today/index" });
    } catch (error) {
      showError(error, "授权没有完成，请重试");
    } finally {
      void wx.hideLoading();
      this.setData({ accepting: false });
    }
  },
});
