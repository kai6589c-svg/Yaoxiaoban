import { afterEach, describe, expect, it, vi } from "vitest";

import { RUNTIME_CONFIG } from "../miniprogram/config/runtime";
import { requestLowFrequencySubscriptions } from "../miniprogram/services/subscription";

type MutableTemplates = {
  expiry: string;
  lowStock: string;
};

const templates =
  RUNTIME_CONFIG.subscriptionTemplates as unknown as MutableTemplates;
const originalTemplates = { ...RUNTIME_CONFIG.subscriptionTemplates };

const installWxMock = () => {
  const requestSubscribeMessage =
    vi.fn<(option: { tmplIds: string[] }) => Promise<Record<string, string>>>();
  vi.stubGlobal("wx", { requestSubscribeMessage });
  return requestSubscribeMessage;
};

describe("低频订阅消息", () => {
  afterEach(() => {
    Object.assign(templates, originalTemplates);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("模板未配置时直接降级，不调用微信 API", async () => {
    Object.assign(templates, { expiry: "", lowStock: "" });
    const requestSubscribeMessage = installWxMock();

    await expect(requestLowFrequencySubscriptions()).resolves.toEqual({
      configured: false,
      accepted: [],
      rejected: [],
    });
    expect(requestSubscribeMessage).not.toHaveBeenCalled();
  });

  it("分别归类 accept 与 reject，并一次提交已配置模板", async () => {
    Object.assign(templates, { expiry: "tmpl-expiry", lowStock: "tmpl-stock" });
    const requestSubscribeMessage = installWxMock();
    requestSubscribeMessage.mockResolvedValue({
      errMsg: "requestSubscribeMessage:ok",
      "tmpl-expiry": "accept",
      "tmpl-stock": "reject",
    });

    await expect(requestLowFrequencySubscriptions()).resolves.toEqual({
      configured: true,
      accepted: ["tmpl-expiry"],
      rejected: ["tmpl-stock"],
    });
    expect(requestSubscribeMessage).toHaveBeenCalledOnce();
    expect(requestSubscribeMessage).toHaveBeenCalledWith({
      tmplIds: ["tmpl-expiry", "tmpl-stock"],
    });
  });

  it("将 ban 与 filter 作为未接受结果返回", async () => {
    Object.assign(templates, { expiry: "tmpl-expiry", lowStock: "tmpl-stock" });
    const requestSubscribeMessage = installWxMock();
    requestSubscribeMessage.mockResolvedValue({
      errMsg: "requestSubscribeMessage:ok",
      "tmpl-expiry": "ban",
      "tmpl-stock": "filter",
    });

    await expect(requestLowFrequencySubscriptions()).resolves.toEqual({
      configured: true,
      accepted: [],
      rejected: ["tmpl-expiry", "tmpl-stock"],
    });
  });
});
