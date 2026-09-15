Component({
  data: {
    selected: 0,
    items: [
      {
        path: "/pages/today/index",
        text: "今天",
        icon: "/assets/icons/today.png",
        activeIcon: "/assets/icons/today-active.png",
      },
      {
        path: "/pages/cabinet/index",
        text: "药箱",
        icon: "/assets/icons/cabinet.png",
        activeIcon: "/assets/icons/cabinet-active.png",
      },
    ],
  },

  methods: {
    switchTab(event: WechatMiniprogram.BaseEvent) {
      const index = Number(event.currentTarget.dataset["index"] ?? 0);
      const item = this.data.items[index];
      if (!item) return;
      const previousIndex = this.data.selected;
      void wx.switchTab({
        url: item.path,
        success: () => this.setData({ selected: index }),
        fail: () => {
          this.setData({ selected: previousIndex });
          void wx.showToast({ title: "页面没有切换成功", icon: "none" });
        },
      });
    },
  },
});
