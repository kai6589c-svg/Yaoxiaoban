"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, parseMap } = require("../lib/config");
const {
  ReminderWorker,
  buildTemplateData,
  retryDelayMs,
} = require("../lib/worker");

function createFixture({
  enabled = true,
  sendError = null,
  subscriptions = { expiry: true, shortage: true },
} = {}) {
  const tasks = [
    {
      _id: "task_1",
      accountId: "acct_1",
      kind: "expiry",
      status: "pending",
      dueAt: "2026-08-19T00:00:00.000Z",
      nextAttemptAt: "2026-08-19T00:00:00.000Z",
      version: 1,
      attempts: 0,
      payload: {
        medicineName: "测试药品",
        date: "2026-09-01",
        message: "药品将在 2026-09-01 到期",
      },
    },
  ];
  let sendCalls = 0;
  let listCalls = 0;
  const store = {
    recoverExpiredLeases: async () => 0,
    listDue: async () => {
      listCalls += 1;
      return tasks.filter((item) => item.status === "pending");
    },
    claim: async (task) => {
      if (task.status !== "pending") return null;
      task.status = "sending";
      task.version += 1;
      return { ...task };
    },
    getAccount: async () => ({ openid: "secret", status: "active" }),
    getSettings: async () => ({ subscriptions }),
    markSent: async () => {
      tasks[0].status = "sent";
      tasks[0].attempts += 1;
    },
    markCanceled: async () => {
      tasks[0].status = "canceled";
    },
    markPermanentFailure: async () => {
      tasks[0].status = "failed_permanent";
      tasks[0].attempts += 1;
    },
    markDeliveryUnknown: async () => {
      tasks[0].status = "delivery_unknown";
    },
    markRetry: async (_task, _now, next, _code, exhausted) => {
      tasks[0].status = exhausted ? "failed_permanent" : "pending";
      tasks[0].nextAttemptAt = next;
      tasks[0].attempts += 1;
    },
  };
  const sender = {
    send: async () => {
      sendCalls += 1;
      if (sendError) throw sendError;
      return { errCode: 0 };
    },
  };
  const config = {
    enabled,
    environmentId: "env-prod",
    page: "pages/today/index",
    miniprogramState: "formal",
    templates: {
      expiry: {
        enabled: true,
        templateId: "template",
        map: { medicineName: "thing1", date: "date2", message: "thing3" },
      },
    },
  };
  const clock = () => new Date("2026-08-19T00:01:00.000Z");
  const worker = new ReminderWorker({
    store,
    sender,
    config,
    clock,
    logger: { warn() {} },
  });
  return {
    worker,
    tasks,
    getSendCalls: () => sendCalls,
    getListCalls: () => listCalls,
  };
}

test("环境开关或环境 ID 为空时配置必定禁用", () => {
  assert.equal(loadConfig({ REMINDER_SEND_ENABLED: "true" }).enabled, false);
  assert.equal(loadConfig({ REMINDER_ENV_ID: "env-prod" }).enabled, false);
  assert.equal(
    loadConfig({ REMINDER_SEND_ENABLED: "true", REMINDER_ENV_ID: "env-prod" })
      .enabled,
    true,
  );
});

test("模板字段映射不合法时安全视为未配置", () => {
  assert.equal(parseMap("{bad json"), null);
  assert.equal(
    parseMap('{"medicineName":"unsupported1","date":"date2"}'),
    null,
  );
  assert.deepEqual(parseMap('{"medicineName":"thing1","date":"date2"}'), {
    medicineName: "thing1",
    date: "date2",
  });
});

test("到期和余量模板没有明确投递类型时保持待配置，不默认为长期订阅", () => {
  const config = loadConfig({
    REMINDER_ENV_ID: "env-prod",
    REMINDER_SEND_ENABLED: "true",
    EXPIRY_TEMPLATE_ID: "expiry-template",
    EXPIRY_TEMPLATE_DATA_MAP: '{"date":"date1","message":"thing2"}',
  });
  assert.equal(config.templates.expiry.enabled, false);
  assert.equal(config.templates.expiry.deliveryType, null);
});

test("服药一次性模板使用已确认的五个字段，不截断剂量或药名", () => {
  const config = loadConfig({
    DOSE_TEMPLATE_ID: "your-dose-template-id",
  });
  assert.equal(config.templates.dose.templateId, "your-dose-template-id");
  assert.deepEqual(config.templates.dose.map, {
    expiryDate: "time3",
    doseTime: "time6",
    dose: "short_thing7",
    medicineName: "short_thing4",
    productName: "thing1",
  });
  const data = buildTemplateData(
    {
      expiryDate: "2026-09-30",
      doseTime: "08:05",
      dose: "1片",
      medicineName: "阿司匹林",
      productName: "药小伴",
    },
    config.templates.dose.map,
    "oneTime",
  );
  assert.deepEqual(data, {
    time3: { value: "2026-09-30" },
    time6: { value: "08:05" },
    short_thing7: { value: "1片" },
    short_thing4: { value: "阿司匹林" },
    thing1: { value: "药小伴" },
  });
  assert.throws(
    () =>
      buildTemplateData(
        { medicineName: "这是一个超过五个字的药名" },
        config.templates.dose.map,
        "oneTime",
      ),
    /TEMPLATE_FIELD_INVALID/,
  );
});

test("全局未启用时不读取任务更不会发送", async () => {
  const fixture = createFixture({ enabled: false });
  const result = await fixture.worker.run();
  assert.equal(result.enabled, false);
  assert.equal(fixture.getListCalls(), 0);
  assert.equal(fixture.getSendCalls(), 0);
});

test("实际运行环境与配置环境不一致时不读取任务也不发送", async () => {
  const fixture = createFixture();
  const result = await fixture.worker.run({
    runtimeEnvironmentId: "another-environment",
  });
  assert.equal(result.enabled, false);
  assert.equal(fixture.getListCalls(), 0);
  assert.equal(fixture.getSendCalls(), 0);
});

test("任务通过原子状态后发送一次，后续执行不重发", async () => {
  const fixture = createFixture();
  const first = await fixture.worker.run();
  const second = await fixture.worker.run();
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(fixture.getSendCalls(), 1);
  assert.equal(fixture.tasks[0].status, "sent");
});

test("用户关闭订阅后任务取消且不发送", async () => {
  const fixture = createFixture({
    subscriptions: { expiry: false, shortage: false },
  });
  const result = await fixture.worker.run();
  assert.equal(result.canceled, 1);
  assert.equal(fixture.getSendCalls(), 0);
  assert.equal(fixture.tasks[0].status, "canceled");
});

test("拒绝订阅等永久错误不重试", async () => {
  const fixture = createFixture({ sendError: { errCode: 43101 } });
  const result = await fixture.worker.run();
  assert.equal(result.failed, 1);
  assert.equal(fixture.tasks[0].status, "failed_permanent");
});

test("消息字段按微信模板长度截断且退避有上限", () => {
  const data = buildTemplateData(
    {
      medicineName: "甲".repeat(30),
      date: "2026-09-01",
      message: "乙".repeat(30),
    },
    {
      medicineName: "thing1",
      date: "date2",
      message: "thing3",
    },
  );
  assert.equal([...data.thing1.value].length, 20);
  assert.equal([...data.thing3.value].length, 20);
  assert.equal(retryDelayMs(20), 24 * 60 * 60 * 1000);
});

test("缺失日期、服药时间或剂量不会被伪造为今天、09:00 或空值", () => {
  assert.throws(
    () =>
      buildTemplateData(
        {
          medicineName: "药",
          productName: "药小伴",
          dose: "1片",
          expiryDate: "2026-09-30",
        },
        { expiryDate: "time3", doseTime: "time6", dose: "short_thing7" },
        "oneTime",
        "detailed",
      ),
    /TEMPLATE_FIELD_INVALID/,
  );
});

test("generic 实际发送内容不包含药名、剂量，非零微信结果不记 sent", async () => {
  const fixture = createFixture();
  let sentData;
  fixture.worker.sender = {
    send: async (message) => {
      sentData = message.data;
      return { errCode: 47003 };
    },
  };
  const result = await fixture.worker.run();
  assert.equal(result.sent, 0);
  assert.equal(fixture.tasks[0].status, "failed_permanent");
  assert.equal(sentData.thing1, undefined);
  assert.equal(sentData.date2.value, "2026-09-01");
});

test("发送响应未知时进入人工对账态，不释放授权也不盲重发", async () => {
  const fixture = createFixture({ sendError: { code: "ETIMEDOUT" } });
  const result = await fixture.worker.run();
  assert.equal(result.sent, 0);
  assert.equal(result.unknown, 1);
  assert.equal(fixture.tasks[0].status, "delivery_unknown");
});

test("日期和时间的格式正确但数值非法时也不能发出", () => {
  assert.throws(
    () =>
      buildTemplateData(
        { date: "2026-02-30", message: "到期" },
        { date: "date1", message: "thing2" },
        "oneTime",
        "generic",
      ),
    /TEMPLATE_FIELD_INVALID/,
  );
  assert.throws(
    () =>
      buildTemplateData(
        { doseTime: "24:00", dose: "1片" },
        { doseTime: "time1", dose: "short_thing2" },
        "oneTime",
        "detailed",
      ),
    /TEMPLATE_FIELD_INVALID/,
  );
});

test("公开版本没有部署模板时不启用服药提醒", () => {
  const config = loadConfig({
    REMINDER_ENV_ID: "env-test",
    REMINDER_SEND_ENABLED: "true",
  });
  assert.equal(config.templates.dose.enabled, false);
  assert.equal(config.templates.dose.templateId, "");
});
