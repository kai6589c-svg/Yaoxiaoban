import { ServiceError } from "./data-service";

export const showError = (
  error: unknown,
  fallback = "操作失败，请稍后重试",
): void => {
  const message =
    error instanceof ServiceError || error instanceof Error
      ? error.message
      : fallback;
  void wx.showToast({
    title: message.slice(0, 20),
    icon: "none",
    duration: 2600,
  });
};

export const withLoading = async <T>(
  title: string,
  action: () => Promise<T>,
): Promise<T> => {
  void wx.showLoading({ title, mask: true });
  try {
    return await action();
  } finally {
    void wx.hideLoading();
  }
};

export const confirm = async (
  title: string,
  content: string,
  confirmText = "确认",
): Promise<boolean> => {
  const result = await wx.showModal({
    title,
    content,
    confirmText,
    confirmColor: "#B63D3D",
    cancelText: "取消",
  });
  return result.confirm;
};
