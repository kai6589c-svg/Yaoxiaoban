export {};

Component({
  data: { top: 24, rowHeight: 48, reserve: 100 },
  lifetimes: {
    attached() {
      this.measure();
    },
  },
  pageLifetimes: {
    show() {
      this.measure();
    },
    resize() {
      this.measure();
    },
  },
  properties: {
    spacer: { type: Boolean, value: false },
    title: {
      type: String,
      value: "",
    },
  },

  methods: {
    measure() {
      try {
        const info = wx.getWindowInfo();
        const textScale = Math.max(
          1,
          Math.min(1.5, (wx.getAppBaseInfo().fontSizeSetting || 16) / 16),
        );
        getCurrentPages().slice(-1)[0]?.setData({ textScale });
        const menu = wx.getMenuButtonBoundingClientRect();
        const top = Math.max(
          info.statusBarHeight || 24,
          info.safeArea?.top || 0,
        );
        const rowHeight = Math.max(
          48,
          menu.bottom - top + Math.max(4, menu.top - top),
        );
        this.setData({
          top,
          rowHeight,
          reserve: Math.max(88, info.windowWidth - menu.left + 12),
        });
      } catch {
        /* Keep conservative spacing on older clients. */
      }
    },
    goBack() {
      if (getCurrentPages().length > 1) {
        void wx.navigateBack();
        return;
      }
      void wx.switchTab({ url: "/pages/today/index" });
    },
  },
});
