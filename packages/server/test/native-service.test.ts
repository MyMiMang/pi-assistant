import { test } from "node:test";
import assert from "node:assert/strict";
import { createCliChannelService } from "../src/cli-channel-service.ts";
import type { PiModels } from "../src/pi-adapter/index.ts";

test("原生服务缓存可失效，退出登录后注销已注册模型", async () => {
 let loggedIn = true;
 let disposed = 0;
 let removed = "";
 let invalidated = 0;
 const models = { unregisterProvider: (id: string) => { removed = id; } } as PiModels;
 const service = createCliChannelService({ id: "test-native", label: "fake", envName: "NATIVE_TEST_COMMAND", allowCommandOverride: () => false, managed: true,
  find: () => process.execPath, notFound: "missing", requireLogin: true,
  detect: async () => ({ installed: true, loggedIn }), invalidate: () => { invalidated++; },
  register: async () => ({ disposeAll: () => { disposed++; } }) });
 try {
  // setup.ts 默认 mock；显式覆盖 mock 的 find 限制不适用于实际注册入口，因此用有效临时强制命令。
  process.env.PIA_NATIVE_TEST_COMMAND = process.execPath;
  const enabled = createCliChannelService({ id: "test-native", label: "fake", envName: "NATIVE_TEST_COMMAND", find: () => null, notFound: "missing", requireLogin: true,
   detect: async () => ({ installed: true, loggedIn }), invalidate: () => { invalidated++; }, register: async () => ({ disposeAll: () => { disposed++; } }) });
  assert.equal((await enabled.check(models)).registered, true);
  loggedIn = false;
  assert.equal((await enabled.check(models, true)).registered, false);
  assert.equal(disposed, 1);
  assert.equal(removed, "test-native");
  assert.equal(invalidated, 1);
  process.env.PIA_NATIVE_TEST_COMMAND = "/definitely/missing";
  assert.equal(service.command(), process.execPath); // 禁止覆盖时继续使用受管 find，忽略环境
 } finally { delete process.env.PIA_NATIVE_TEST_COMMAND; }
});
