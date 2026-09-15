import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
import { loadDeployment } from "./deployment-config.mjs";
const deployment = await loadDeployment();
const EXPECTED_APP_ID = deployment.appId;
const EXPECTED_CLOUD_ENV = deployment.cloudEnvId;
const VERIFIED_STABLE_LIB = "3.16.2";

const fail = (message) => {
  throw new Error(`RELEASE_CONFIG_INVALID: ${message}`);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};
const readText = (relativePath) =>
  readFile(path.join(projectRoot, relativePath), "utf8");
const readJson = async (relativePath) =>
  JSON.parse(await readText(relativePath));

const project = await readJson("project.config.json");
const privateProject = await readJson("project.private.config.json").catch(
  () => null,
);
assert(project.appid === EXPECTED_APP_ID, "AppID 不是已验收的正式 AppID");
assert(project.projectname === "yaoxiaoban", "项目名必须为 yaoxiaoban");
assert(
  project.miniprogramRoot === "dist/miniprogram/",
  "开发者工具必须运行正式构建产物 dist/miniprogram/",
);
assert(
  project.cloudfunctionRoot === "dist/cloudfunctions/",
  "开发者工具必须运行独立构建产物 dist/cloudfunctions/",
);
assert(project.libVersion === VERIFIED_STABLE_LIB, "基础库不是已验收稳定版");
assert(project.setting?.urlCheck === true, "上传配置不得关闭合法域名校验");
assert(project.setting?.minified === true, "上传时必须压缩脚本");
assert(project.setting?.minifyWXSS === true, "上传时必须压缩 WXSS");
assert(project.setting?.minifyWXML === true, "上传时必须压缩 WXML");
assert(
  project.setting?.ignoreUploadUnusedFiles === true,
  "上传时必须过滤无依赖文件",
);
assert(
  project.setting?.compileHotReLoad === false,
  "发布项目不得启用自动热重载",
);
assert(
  privateProject?.setting?.compileHotReLoad !== true,
  "私有配置不得覆盖开启自动热重载",
);

const cloudbase = await readJson("cloudbaserc.json");
assert(cloudbase.envId === EXPECTED_CLOUD_ENV, "CLI 没有绑定正式云环境");
assert(
  cloudbase.functionRoot === "./dist/cloudfunctions",
  "CLI 云函数根目录配置错误",
);
assert(
  Array.isArray(cloudbase.functions) && cloudbase.functions.length === 3,
  "CLI 必须声明 medicine-api、reminder-worker 和 maintenance-worker",
);
const functionsByName = new Map(
  cloudbase.functions.map((item) => [item.name, item]),
);
const medicineFunction = functionsByName.get("medicine-api");
const workerFunction = functionsByName.get("reminder-worker");
const maintenanceFunction = functionsByName.get("maintenance-worker");
assert(
  medicineFunction && workerFunction && maintenanceFunction,
  "CLI 云函数清单不完整",
);
for (const [name, item, timeout] of [
  ["medicine-api", medicineFunction, 30],
  ["reminder-worker", workerFunction, 60],
  ["maintenance-worker", maintenanceFunction, 60],
]) {
  assert(item.runtime === "Nodejs16.13", `${name} 运行时与线上不一致`);
  assert(item.handler === "index.main", `${name} 执行方法错误`);
  assert(item.memorySize === 256, `${name} 内存必须为 256 MB`);
  assert(item.timeout === timeout, `${name} 超时配置错误`);
  assert(item.installDependency === true, `${name} 必须云端安装依赖`);
}
assert(
  medicineFunction.triggers === undefined ||
    medicineFunction.triggers.length === 0,
  "medicine-api 不得配置触发器",
);
assert(
  workerFunction.triggers?.length === 1 &&
    workerFunction.triggers[0].name === "dispatch-due-reminders" &&
    workerFunction.triggers[0].type === "timer" &&
    workerFunction.triggers[0].config === "0 * * * * * *",
  "CLI 中 reminder-worker 必须且只能保留每分钟定时触发器",
);
assert(
  maintenanceFunction.triggers?.length === 1 &&
    maintenanceFunction.triggers[0].name ===
      "run-maintenance-every-fifteen-minutes" &&
    maintenanceFunction.triggers[0].type === "timer" &&
    maintenanceFunction.triggers[0].config === "0 */15 * * * * *",
  "CLI 中 maintenance-worker 必须且只能保留 15 分钟定时触发器",
);

const app = await readJson("dist/miniprogram/app.json");
assert(
  app.window?.visualEffectInBackground === "hidden",
  "进入后台时必须隐藏医疗健康页面",
);
assert(app.lazyCodeLoading === "requiredComponents", "必须启用按需组件注入");
assert(app.sitemapLocation === "sitemap.json", "缺少 sitemap 配置");

const runtimeSource = await readText("miniprogram/config/runtime.ts");
const runtimeBuild = await readText("dist/miniprogram/config/runtime.js");
for (const [label, source] of [
  ["源码", runtimeSource],
  ["构建产物", runtimeBuild],
]) {
  assert(
    new RegExp(`deploymentMode:\\s*["']${deployment.deploymentMode}["']`).test(
      source,
    ),
    `${label}不是 production 模式`,
  );
  assert(source.includes(EXPECTED_CLOUD_ENV), `${label}没有正式云环境 ID`);
  if (deployment.deploymentMode === "production")
    assert(!source.includes("touristappid"), `${label}含 touristappid`);
}
assert(
  runtimeBuild.includes(JSON.stringify(deployment.subscriptionTemplates.dose)),
  "服药时间一次性模板 ID 未进入构建产物",
);

const medicineConfig = await readJson(
  "dist/cloudfunctions/medicine-api/config.json",
);
assert(
  Array.isArray(medicineConfig.permissions?.openapi) &&
    medicineConfig.permissions.openapi.length === 0,
  "medicine-api 不应申请微信 OpenAPI 权限",
);
const workerConfig = await readJson(
  "dist/cloudfunctions/reminder-worker/config.json",
);
assert(
  JSON.stringify(workerConfig.permissions?.openapi) ===
    JSON.stringify(["subscribeMessage.send"]),
  "reminder-worker 只能申请 subscribeMessage.send",
);
assert(
  workerConfig.triggers?.length === 1 &&
    workerConfig.triggers[0].type === "timer" &&
    workerConfig.triggers[0].name === "dispatch-due-reminders" &&
    workerConfig.triggers[0].config === "0 * * * * * *",
  "reminder-worker 必须且只能保留每分钟定时触发器",
);
const maintenanceConfig = await readJson(
  "dist/cloudfunctions/maintenance-worker/config.json",
);
assert(
  maintenanceConfig.triggers?.length === 1 &&
    maintenanceConfig.triggers[0].type === "timer" &&
    maintenanceConfig.triggers[0].config === "0 */15 * * * * *",
  "maintenance-worker 必须且只能保留 15 分钟定时触发器",
);

for (const name of ["medicine-api", "reminder-worker", "maintenance-worker"]) {
  const entry = await readText(`dist/cloudfunctions/${name}/index.js`);
  assert(/exports\.main\s*=/.test(entry), `${name} 构建包缺少 index.main`);
  const packageJson = await readJson(
    `dist/cloudfunctions/${name}/package.json`,
  );
  assert(
    packageJson.dependencies?.["wx-server-sdk"],
    `${name} 缺少生产依赖声明`,
  );
}

const sourceFiles = [];
const collectFiles = async (directory) => {
  const entries = await readdir(path.join(projectRoot, directory), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const relativePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(relativePath);
    else if (/\.(?:ts|js|json|wxml)$/.test(entry.name))
      sourceFiles.push(relativePath);
  }
};
await collectFiles("miniprogram");
const miniprogramSource = (
  await Promise.all(sourceFiles.map((file) => readText(file)))
).join("\n");
assert(
  !/wx\.cloud\.database\s*\(/.test(miniprogramSource),
  "客户端不得直连 CloudBase 数据库",
);
assert(
  !/traceUser\s*:\s*true/.test(miniprogramSource),
  "生产环境不得开启 traceUser",
);
assert(
  !/console\.(?:log|info|debug|warn|error)\s*\(/.test(miniprogramSource),
  "小程序源码不得输出控制台日志",
);

console.log(
  `[release] config ok: AppID ${EXPECTED_APP_ID}, env ${EXPECTED_CLOUD_ENV}, base library ${VERIFIED_STABLE_LIB}, configured client`,
);
