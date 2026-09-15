import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDeployment, root } from "./deployment-config.mjs";
const config = await loadDeployment();
for (const [name, key, value] of [
  ["project.config", "appid", config.appId],
  ["cloudbaserc", "envId", config.cloudEnvId],
]) {
  const template = JSON.parse(
    await readFile(path.join(root, `${name}.example.json`), "utf8"),
  );
  template[key] = value;
  await writeFile(
    path.join(root, `${name}.json`),
    JSON.stringify(template, null, 2) + "\n",
  );
}
let runtime = await readFile(
  path.join(root, "miniprogram/config/runtime.example.ts"),
  "utf8",
);
runtime = runtime
  .replace(
    'deploymentMode: "demo"',
    `deploymentMode: ${JSON.stringify(config.deploymentMode)}`,
  )
  .replace(
    'cloudEnvId: ""',
    `cloudEnvId: ${JSON.stringify(config.cloudEnvId)}`,
  );
for (const [key, value] of Object.entries(config.subscriptionTemplates))
  runtime = runtime.replace(`${key}: ""`, `${key}: ${JSON.stringify(value)}`);
await writeFile(path.join(root, "miniprogram/config/runtime.ts"), runtime);
console.log(
  `Configured ${config.deploymentMode} mode; deployment files remain local.`,
);
