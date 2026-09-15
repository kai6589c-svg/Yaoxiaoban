import { openCalendarPermissionSettings } from "../../services/calendar";

Component({
  properties: {
    textScale: { type: Number, value: 1 },
    doseCopy: { type: String, value: "按固定服药计划提醒" },
    expiryCopy: { type: String, value: "按已设置的提前天数提醒" },
    shortageCopy: { type: String, value: "按预计不足时间提醒" },
    open: { type: Boolean, value: false },
    hasFixedPlan: { type: Boolean, value: false },
    calendarText: { type: String, value: "" },
    busy: { type: Boolean, value: false },
    doseStatus: { type: String, value: "待授权" },
    expiryStatus: { type: String, value: "待配置" },
    shortageStatus: { type: String, value: "待配置" },
  },

  data: {
    openingSettings: false,
    calendarDenied: false,
    calendarAdded: false,
    calendarStatus: "未添加",
  },

  observers: {
    calendarText(text: string) {
      const added = text.includes("已请求添加");
      const partial = text.includes("部分");
      const ended = text.includes("覆盖期限已结束");
      this.setData({
        calendarAdded: added,
        calendarStatus: ended
          ? "待更新"
          : partial
            ? "部分已添加"
            : added
              ? "已添加"
              : "未添加",
      });
    },
    open(open: boolean) {
      if (open) void this.refreshPermissionDisplay();
    },
  },
  pageLifetimes: {
    show() {
      if (this.properties.open) void this.refreshPermissionDisplay();
    },
  },

  methods: {
    // Read-only presentation state. This never requests permission or writes events.
    async refreshPermissionDisplay() {
      let denied = false;
      try {
        denied =
          typeof wx.getAppAuthorizeSetting === "function" &&
          wx.getAppAuthorizeSetting().phoneCalendarAuthorized === "denied";
      } catch {
        /* Unavailable permission information is not a denial. */
      }
      try {
        const settings = await wx.getSetting();
        denied =
          denied || settings.authSetting?.["scope.addPhoneCalendar"] === false;
      } catch {
        /* Preserve the known system result on older clients. */
      }
      this.setData({ calendarDenied: denied });
    },
    close() {
      if (!this.properties.busy) this.triggerEvent("close");
    },

    requestKind(event: WechatMiniprogram.BaseEvent) {
      const kind = String(event.currentTarget.dataset["kind"] ?? "");
      if (["dose", "expiry", "shortage"].includes(kind))
        this.triggerEvent("request", { kind });
    },

    async explainWechat() {
      await wx.showModal({
        title: "微信提醒需逐类授权",
        content:
          "服药时间、到期和余量不足分别申请一次授权；长期提醒资格未确认前，手机日历仍可作为持续提醒方式。",
        showCancel: false,
        confirmText: "知道了",
      });
    },

    async openCalendarSettings() {
      if (this.data.openingSettings) return;
      this.setData({ openingSettings: true });
      try {
        await openCalendarPermissionSettings();
      } catch (error) {
        await wx.showModal({
          title: "请在手机中设置日历权限",
          content:
            error instanceof Error
              ? error.message
              : "未能打开授权设置。请在手机系统设置中找到微信，检查日历权限。小程序不能直接打开日历 App 的设置页。",
          showCancel: false,
          confirmText: "知道了",
          confirmColor: "#167A50",
        });
      } finally {
        this.setData({ openingSettings: false });
        void this.refreshPermissionDisplay();
      }
    },

    writeCalendar() {
      if (!this.properties.busy && this.properties.hasFixedPlan)
        this.triggerEvent("writecalendar");
    },

    noop() {},
  },
});
