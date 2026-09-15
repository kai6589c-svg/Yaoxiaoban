import assert from "node:assert/strict";
import test from "node:test";
import { validateDeployment } from "./deployment-config.mjs";
const demo = { deploymentMode: "demo", appId: "touristappid", cloudEnvId: "" };
test("demo cannot accidentally connect to production", () => {
  assert.throws(() =>
    validateDeployment({ ...demo, cloudEnvId: "cloud-test" }),
  );
  assert.equal(validateDeployment(demo).subscriptionTemplates.dose, "");
});
test("production rejects missing or placeholder destinations", () => {
  assert.throws(() =>
    validateDeployment({ ...demo, deploymentMode: "production" }),
  );
  assert.throws(() =>
    validateDeployment({
      ...demo,
      deploymentMode: "production",
      appId: "wx0000000000000000",
      cloudEnvId: "cloud-test",
    }),
  );
});
test("valid production configuration retains explicit templates", () => {
  const config = validateDeployment({
    deploymentMode: "production",
    appId: "wx1234567890abcdef",
    cloudEnvId: "cloud-test",
    subscriptionTemplates: { dose: "template-test" },
  });
  assert.equal(config.subscriptionTemplates.dose, "template-test");
});
test("configuration cannot inject JavaScript into generated files", () => {
  assert.throws(() =>
    validateDeployment({
      ...demo,
      subscriptionTemplates: { dose: '"; evil();' },
    }),
  );
});
