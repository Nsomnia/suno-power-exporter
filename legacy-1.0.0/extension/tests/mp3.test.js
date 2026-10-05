import test from "node:test";
import assert from "node:assert/strict";

test("MP3 downloader no longer depends on an undeclared auth helper", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.chrome = { storage: { local: { get: async () => ({}) } } };
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "audio/mpeg" },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
  });
  try {
    const moduleUrl = `../lib/m4a-decrypt.js?mp3=${Date.now()}`;
    const { downloadMp3 } = await import(moduleUrl);
    const result = await downloadMp3("clip", { audio_url: "https://cdn.example/track.mp3" });
    assert.equal(result.byteLength, 3);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
