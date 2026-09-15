import { RUNTIME_CONFIG } from "../../config/runtime";
import type { AppState, Profile } from "../../core/models";
import { showError } from "../../services/ui";

interface RelationOption {
  value: Profile["relation"];
  label: string;
}

interface ColorOption {
  value: string;
  label: string;
}

interface ProfileView extends Profile {
  initial: string;
  relationLabel: string;
  medicationCount: number;
}

interface ProfilesPageData {
  loading: boolean;
  loadFailed: boolean;
  profiles: ProfileView[];
  archivedProfiles: ProfileView[];
  relationOptions: RelationOption[];
  colorOptions: ColorOption[];
  editorOpen: boolean;
  editorId: string;
  editorVersion: number;
  editorName: string;
  editorRelation: Profile["relation"];
  editorColor: string;
  authorizationConfirmed: boolean;
  formError: string;
  saving: boolean;
  archivingId: string;
}

const RELATION_OPTIONS: RelationOption[] = [
  { value: "self", label: "我" },
  { value: "parent", label: "父母" },
  { value: "child", label: "子女" },
  { value: "partner", label: "伴侣" },
  { value: "other", label: "其他" },
];

const COLOR_OPTIONS: ColorOption[] = [
  { value: "#4E8D70", label: "森林绿" },
  { value: "#3E719A", label: "湖水蓝" },
  { value: "#9A663E", label: "暖褐色" },
  { value: "#81649A", label: "藤紫色" },
  { value: "#A14E5C", label: "莎红色" },
];

const relationLabel = (relation: Profile["relation"]): string =>
  RELATION_OPTIONS.find((item) => item.value === relation)?.label ?? "其他";

const isRelation = (value: string): value is Profile["relation"] =>
  RELATION_OPTIONS.some((item) => item.value === value);

const initialData: ProfilesPageData = {
  loading: true,
  loadFailed: false,
  profiles: [],
  archivedProfiles: [],
  relationOptions: RELATION_OPTIONS,
  colorOptions: COLOR_OPTIONS,
  editorOpen: false,
  editorId: "",
  editorVersion: 0,
  editorName: "",
  editorRelation: "other",
  editorColor: COLOR_OPTIONS[0]?.value ?? "#4E8D70",
  authorizationConfirmed: false,
  formError: "",
  saving: false,
  archivingId: "",
};

Page({
  data: initialData,

  onShow() {
    if (!this.data.editorOpen) void this.loadProfiles();
  },

  async loadProfiles() {
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
      showError(error, "成员资料暂时没加载出来");
    }
  },

  applyState(state: AppState) {
    const medicationCounts = new Map<string, number>();
    for (const medication of state.medications) {
      if (!medication.archivedAt) {
        medicationCounts.set(
          medication.profileId,
          (medicationCounts.get(medication.profileId) ?? 0) + 1,
        );
      }
    }
    const decorated: ProfileView[] = state.profiles.map((profile) => ({
      ...profile,
      initial: profile.name.slice(0, 1),
      relationLabel: relationLabel(profile.relation),
      medicationCount: medicationCounts.get(profile.id) ?? 0,
    }));
    this.setData({
      profiles: decorated.filter((profile) => !profile.archivedAt),
      archivedProfiles: decorated.filter((profile) =>
        Boolean(profile.archivedAt),
      ),
    });
  },

  openAdd() {
    this.setData({
      editorOpen: true,
      editorId: "",
      editorVersion: 0,
      editorName: "",
      editorRelation: "other",
      editorColor: COLOR_OPTIONS[0]?.value ?? "#4E8D70",
      authorizationConfirmed: false,
      formError: "",
    });
  },

  openEdit(event: WechatMiniprogram.BaseEvent) {
    const { id } = event.currentTarget.dataset as { id?: string };
    const profile = this.data.profiles.find((item) => item.id === id);
    if (!profile) return;
    this.setData({
      editorOpen: true,
      editorId: profile.id,
      editorVersion: profile.version,
      editorName: profile.name,
      editorRelation: profile.relation,
      editorColor: profile.color,
      authorizationConfirmed: profile.relation === "self",
      formError: "",
    });
  },

  closeEditor() {
    if (this.data.saving) return;
    this.setData({ editorOpen: false, formError: "" });
  },

  onNameInput(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ editorName: event.detail.value, formError: "" });
  },

  chooseRelation(event: WechatMiniprogram.BaseEvent) {
    const { relation } = event.currentTarget.dataset as { relation?: string };
    if (!relation || !isRelation(relation)) return;
    this.setData({
      editorRelation: relation,
      authorizationConfirmed: relation === "self",
      formError: "",
    });
  },

  chooseColor(event: WechatMiniprogram.BaseEvent) {
    const { color } = event.currentTarget.dataset as { color?: string };
    if (!color || !COLOR_OPTIONS.some((item) => item.value === color)) return;
    this.setData({ editorColor: color });
  },

  onAuthorizationChange(
    event: WechatMiniprogram.CustomEvent<{ value: string[] }>,
  ) {
    this.setData({
      authorizationConfirmed: event.detail.value.includes("authorized"),
      formError: "",
    });
  },

  async saveProfile() {
    if (this.data.saving) return;
    const name = this.data.editorName.trim();
    if (!name) {
      this.setData({ formError: "请填写成员称呼" });
      return;
    }
    if (name.length > 10) {
      this.setData({ formError: "称呼不能超过10个字" });
      return;
    }
    const anotherSelf = this.data.profiles.some(
      (profile) =>
        profile.relation === "self" && profile.id !== this.data.editorId,
    );
    if (this.data.editorRelation === "self" && anotherSelf) {
      this.setData({ formError: "已有“我”这位成员，请选择其他关系" });
      return;
    }
    if (
      this.data.editorRelation !== "self" &&
      !this.data.authorizationConfirmed
    ) {
      this.setData({
        formError:
          this.data.editorRelation === "child"
            ? "请先确认监护人授权"
            : "请先确认已获得该成员授权",
      });
      return;
    }

    this.setData({ saving: true, formError: "" });
    void wx.showLoading({ title: "正在保存", mask: true });
    try {
      const state = await getApp<IAppOption>()
        .getService()
        .upsertProfile({
          id: this.data.editorId || undefined,
          name,
          relation: this.data.editorRelation,
          color: this.data.editorColor,
          expectedVersion: this.data.editorId
            ? this.data.editorVersion
            : undefined,
        });
      this.applyState(state);
      this.setData({ editorOpen: false });
      void wx.showToast({
        title: this.data.editorId ? "已更新" : "已添加",
        icon: "success",
      });
    } catch (error) {
      showError(error, "成员资料没有保存成功");
    } finally {
      void wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  async archiveProfile(event: WechatMiniprogram.BaseEvent) {
    const { id } = event.currentTarget.dataset as { id?: string };
    const profile = this.data.profiles.find((item) => item.id === id);
    if (!profile || this.data.archivingId) return;
    if (this.data.profiles.length <= 1) {
      void wx.showToast({ title: "至少保留一位成员", icon: "none" });
      return;
    }
    if (profile.medicationCount > 0) {
      await wx.showModal({
        title: "暂时不能移除",
        content: `请先移除“${profile.name}”名下的 ${profile.medicationCount} 种药品，再移除成员。`,
        showCancel: false,
        confirmText: "知道了",
      });
      return;
    }

    const decision = await wx.showModal({
      title: `移除“${profile.name}”？`,
      content: "移除后不再出现在添加和筛选中，历史记录仍会保留。",
      confirmText: "移除",
      confirmColor: "#B63D3D",
      cancelText: "取消",
    });
    if (!decision.confirm) return;

    this.setData({ archivingId: profile.id });
    void wx.showLoading({ title: "正在移除", mask: true });
    try {
      const state = await getApp<IAppOption>()
        .getService()
        .archiveProfile(profile.id, profile.version);
      this.applyState(state);
      void wx.showToast({ title: "已移除", icon: "success" });
    } catch (error) {
      showError(error, "移除没有完成");
    } finally {
      void wx.hideLoading();
      this.setData({ archivingId: "" });
    }
  },

  noop() {},
});
