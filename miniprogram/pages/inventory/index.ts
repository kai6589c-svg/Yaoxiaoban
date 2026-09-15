import { formatDose, formatLocalDateTime } from "../../core/dates";
import { resolveExpiry } from "../../core/expiry";
import { estimateInventory } from "../../core/inventory";
import { createRequestId } from "../../core/id";
import { showError } from "../../services/ui";

Page({
  data: {
    loading: true,
    error: "",
    saving: false,
    medicationId: "",
    medicationName: "",
    unit: "",
    estimateText: "尚未盘点",
    quantity: "",
    recordedAtText: "",
  },

  onLoad(options: Record<string, string | undefined>) {
    this.setData({ medicationId: options["id"] ?? "" });
  },

  async onShow() {
    await this.loadData();
  },

  async loadData() {
    this.setData({ loading: true, error: "" });
    try {
      const state = await getApp<IAppOption>().getService().bootstrap();
      const medication = state.medications.find(
        (item) => item.id === this.data.medicationId,
      );
      if (!medication) throw new Error("药品不存在");
      if (!medication.unit) throw new Error("请先在药盒编辑页设置数量单位");
      const estimate = estimateInventory({
        medicationId: medication.id,
        plans: state.plans,
        snapshots: state.snapshots,
        logs: state.intakeLogs,
        asOfMs: Date.now(),
        stopAtDate: resolveExpiry(medication).effectiveExpiryDate,
      });
      this.setData({
        loading: false,
        medicationName: medication.name,
        unit: medication.unit,
        estimateText:
          estimate.currentQuantityMilli === null
            ? "尚未盘点"
            : `当前${formatDose(estimate.currentQuantityMilli, medication.unit)}`,
        quantity:
          estimate.currentQuantityMilli === null
            ? ""
            : String(estimate.currentQuantityMilli / 1000),
        recordedAtText: formatLocalDateTime(Date.now()),
      });
    } catch (error) {
      showError(error);
      this.setData({
        loading: false,
        error: error instanceof Error ? error.message : "没有加载成功",
      });
    }
  },

  onQuantityInput(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ quantity: event.detail.value });
  },

  async save() {
    if (this.data.saving) return;
    const quantity = Number(this.data.quantity);
    if (
      !Number.isFinite(quantity) ||
      quantity < 0 ||
      Math.round(quantity * 1000) !== quantity * 1000
    ) {
      void wx.showToast({
        title: "请输入最多三位小数的非负数量",
        icon: "none",
      });
      return;
    }
    this.setData({ saving: true });
    try {
      await getApp<IAppOption>()
        .getService()
        .confirmInventory({
          medicationId: this.data.medicationId,
          quantityMilli: Math.round(quantity * 1000),
          note: "手动盘点",
          requestId: createRequestId(),
        });
      await wx.showModal({
        title: "盘点已更新",
        content: `实际数量 ${quantity}${this.data.unit}。之后将按服药计划继续估算。`,
        showCancel: false,
        confirmText: "知道了",
        confirmColor: "#167A50",
      });
      void wx.navigateBack({
        fail: () =>
          wx.redirectTo({
            url: `/pages/medicine-detail/index?id=${this.data.medicationId}`,
          }),
      });
    } catch (error) {
      showError(error, "没有保存成功，输入内容仍保留在本页");
      this.setData({ saving: false });
    }
  },

  retry() {
    void this.loadData();
  },
});
