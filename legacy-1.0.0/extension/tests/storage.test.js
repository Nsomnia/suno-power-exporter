import test from "node:test";
import assert from "node:assert/strict";

test("settings migration makes complete sync the default", async () => {
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ sppe_settings: { ignoreDisliked: true, settingsVersion: 1 } }),
        set: async () => {}
      },
      onChanged: { addListener() {} }
    }
  };
  const moduleUrl = `../lib/storage.js?migration=${Date.now()}`;
  const { getSettings } = await import(moduleUrl);
  const settings = await getSettings();
  assert.equal(settings.ignoreDisliked, false);
  assert.equal(settings.settingsVersion, 3);
});

test("current settings win over legacy keys after migration", async () => {
  const removed = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => Array.isArray(key)
          ? { sppe_settings: { shortId: true, rateLimitMs: 2400, settingsVersion: 3 }, includeShortUuid: false, rateLimitConfig: { delayMs: 25 } }
          : { sppe_settings: { shortId: true, rateLimitMs: 2400, settingsVersion: 3 } },
        set: async () => {},
        remove: async (keys) => removed.push(keys)
      },
      onChanged: { addListener() {} }
    }
  };
  const moduleUrl = `../lib/storage.js?legacy=${Date.now()}`;
  const { getSettings } = await import(moduleUrl);
  const settings = await getSettings();
  assert.equal(settings.shortId, true);
  assert.equal(settings.rateLimitMs, 2400);
  assert.equal(removed.length, 1);
});
