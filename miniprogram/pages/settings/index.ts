import { diagnosticReport } from "../../services/diagnostics";
import { readableMedicineList } from "../../services/readable-export";
import { RUNTIME_CONFIG } from "../../config/runtime";
import type { AccountSettings, AppState } from "../../core/models";
import { showError } from "../../services/ui";

interface NumberOption {
  label: string;
  value: number;
}

interface SettingsPageData {
  demoMode: boolean;
  loading: boolean;
  loadFailed: boolean;
  savingKey: string;
  expiryOptions: NumberOption[];
  stockOptions: NumberOption[];
  expiryIndex: number;
  stockIndex: number;
  expiryLabel: string;
  stockLabel: string;
  notificationDetailed: boolean;
  hasCalendarExports: boolean;
  exporting: boolean;
  deleteOpen: boolean;
  deleteStep: 1 | 2;
  calendarAcknowledged: boolean;
  deletePhrase: string;
  deleting: boolean;
  reminderOpen: boolean;
}

const EXPIRY_OPTIONS: NumberOption[] = [
  { label: "提前 7 天", value: 7 },
  { label: "提前 30 天", value: 30 },
  { label: "提前 90 天", value: 90 },
];

const STOCK_OPTIONS: NumberOption[] = [
  { label: "提前 3 天", value: 3 },
  { label: "提前 7 天", value: 7 },
  { label: "提前 14 天", value: 14 },
];

const initialData: SettingsPageData = {
  demoMode: RUNTIME_CONFIG.deploymentMode === "demo",
  loading: true,
  loadFailed: false,
  savingKey: "",
  expiryOptions: EXPIRY_OPTIONS,
  stockOptions: STOCK_OPTIONS,
  expiryIndex: 1,
  stockIndex: 1,
  expiryLabel: EXPIRY_OPTIONS[1]?.label ?? "提前 30 天",
  stockLabel: STOCK_OPTIONS[1]?.label ?? "提前 7 天",
  notificationDetailed: false,
  hasCalendarExports: false,
  exporting: false,
  deleteOpen: false,
  deleteStep: 1,
  calendarAcknowledged: false,
  deletePhrase: "",
  deleting: false,
  reminderOpen: false,
};

Page({
  data: initialData,

  openPendingSaves() {
    void wx.navigateTo({ url: "/pages/sync/index" });
  },

  onShow() {
    void this.loadSettings();
  },

  async loadSettings() {
    this.setData({ loading: true, loadFailed: false });
    try {
      const state = await getApp<IAppOption>().getService().bootstrap();
      if (
        state.settings.privacyAcceptedVersion !== RUNTIME_CONFIG.privacyVersion
      ) {
        void wx.reLaunch({ url: "/pages/start/index" });
        return;
      }
      this.applyState(state);
      this.setData({ loading: false });
    } catch (error) {
      this.setData({ loading: false, loadFailed: true });
      showError(error, "设置暂时没加载出来");
    }
  },

  applyState(state: AppState) {
    const expiryIndex = Math.max(
      0,
      EXPIRY_OPTIONS.findIndex(
        (option) => option.value === state.settings.expiryLeadDays,
      ),
    );
    const stockIndex = Math.max(
      0,
      STOCK_OPTIONS.findIndex(
        (option) => option.value === state.settings.lowStockLeadDays,
      ),
    );
    this.setData({
      expiryIndex,
      stockIndex,
      expiryLabel: EXPIRY_OPTIONS[expiryIndex]?.label ?? "提前 30 天",
      stockLabel: STOCK_OPTIONS[stockIndex]?.label ?? "提前 7 天",
      notificationDetailed: state.settings.notificationPrivacy === "detailed",
      hasCalendarExports: state.calendarExports.length > 0,
    });
  },

  async savePatch(
    key: string,
    patch: Partial<AccountSettings>,
  ): Promise<boolean> {
    if (this.data.savingKey) return false;
    this.setData({ savingKey: key });
    try {
      const state = await getApp<IAppOption>()
        .getService()
        .updateSettings(patch);
      this.applyState(state);
      void wx.showToast({ title: "已更新", icon: "success" });
      return true;
    } catch (error) {
      showError(error, "设置没有保存成功");
      return false;
    } finally {
      this.setData({ savingKey: "" });
    }
  },

  onExpiryChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const option = EXPIRY_OPTIONS[Number(event.detail.value)];
    if (!option) return;
    void this.savePatch("expiry", { expiryLeadDays: option.value });
  },

  onStockChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const option = STOCK_OPTIONS[Number(event.detail.value)];
    if (!option) return;
    void this.savePatch("stock", { lowStockLeadDays: option.value });
  },

  async onPrivacyDisplayChange(
    event: WechatMiniprogram.CustomEvent<{ value: boolean }>,
  ) {
    const changed = await this.savePatch("privacy", {
      notificationPrivacy: event.detail.value ? "detailed" : "generic",
    });
    if (changed && this.data.hasCalendarExports) {
      await wx.showModal({
        title: "旧日历标题不会自动变化",
        content:
          "这个设置只影响以后写入的提醒。请在手机系统日历中删除旧事件，再到药盒详情重新写入。",
        showCancel: false,
        confirmText: "知道了",
      });
    }
  },

  openReminders() {
    this.setData({ reminderOpen: true });
  },

  closeReminders() {
    this.setData({ reminderOpen: false });
  },

  openProfiles() {
    void wx.navigateTo({ url: "/pages/profiles/index" });
  },

  openPrivacy() {
    void wx.navigateTo({ url: "/pages/privacy/index" });
  },

  async copyDiagnostic() {
    try {
      await wx.setClipboardData({ data: diagnosticReport() });
    } catch (error) {
      showError(error, "未能复制诊断编号");
    }
  },
  async exportMedicineList() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    try {
      const state = await getApp<IAppOption>().getService().bootstrap();
      const result = await wx.showModal({
        title: "复制药盒清单？",
        content: "包含成员、药名、规格和日期，可粘贴到备忘录阅读。",
        confirmText: "复制清单",
      });
      if (result.confirm)
        await wx.setClipboardData({ data: readableMedicineList(state) });
    } catch (error) {
      showError(error, "导出未完成");
    } finally {
      this.setData({ exporting: false });
    }
  },
  async exportAndCopy() {
    if (this.data.exporting) return;
    const decision = await wx.showModal({
      title: "导出我的数据",
      content:
        "导出内容包含药名、用量和服药记录，属于敏感信息。请只复制到你信任的位置。",
      confirmText: "生成并复制",
      cancelText: "取消",
    });
    if (!decision.confirm) return;

    this.setData({ exporting: true });
    void wx.showLoading({ title: "正在生成", mask: true });
    try {
      const exported = await getApp<IAppOption>().getService().exportData();
      await wx.setClipboardData({ data: exported });
      await wx.showModal({
        title: "已复制导出数据",
        content:
          "内容已复制到剪贴板。请尽快保存到安全位置，用完后及时清理剪贴板。",
        showCancel: false,
        confirmText: "知道了",
      });
    } catch (error) {
      showError(error, "导出没有完成，请重试");
    } finally {
      void wx.hideLoading();
      this.setData({ exporting: false });
    }
  },

  openDelete() {
    this.setData({
      deleteOpen: true,
      deleteStep: 1,
      calendarAcknowledged: false,
      deletePhrase: "",
    });
  },

  closeDelete() {
    if (this.data.deleting) return;
    this.setData({ deleteOpen: false, deletePhrase: "" });
  },

  onCalendarAcknowledgement(
    event: WechatMiniprogram.CustomEvent<{ value: string[] }>,
  ) {
    this.setData({
      calendarAcknowledged: event.detail.value.includes("calendar"),
    });
  },

  continueDelete() {
    if (this.data.hasCalendarExports && !this.data.calendarAcknowledged) {
      void wx.showToast({ title: "请先确认日历提醒说明", icon: "none" });
      return;
    }
    this.setData({ deleteStep: 2, deletePhrase: "" });
  },

  backDeleteStep() {
    if (this.data.deleting) return;
    this.setData({ deleteStep: 1, deletePhrase: "" });
  },

  onDeletePhraseInput(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ deletePhrase: event.detail.value });
  },

  async confirmDelete() {
    if (this.data.deletePhrase.trim() !== "删除" || this.data.deleting) return;
    this.setData({ deleting: true });
    void wx.showLoading({ title: "正在删除", mask: true });
    try {
      await getApp<IAppOption>().getService().deleteAccount();
      void wx.hideLoading();
      await wx.showModal({
        title: "删除申请已提交",
        content:
          "账号访问和提醒已停用，云端清理将继续完成。手机日历中的旧提醒仍需自行删除。",
        showCancel: false,
        confirmText: "知道了",
      });
      void wx.reLaunch({ url: "/pages/start/index" });
    } catch (error) {
      void wx.hideLoading();
      showError(error, "删除没有完成，你的数据仍然保留");
      this.setData({ deleting: false });
    }
  },

  noop() {},
});
