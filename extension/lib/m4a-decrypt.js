// lib/m4a-decrypt.js — Mango DRM M4A decryption pipeline.
// Logic based on the userscript's decryptAndFetchAudioBuffer (Python suno_folder_decode port).
import { MANGO_CDN } from "./utils.js";
import { fetchClipMetadata, fetchMangoRights } from "./api.js";

async function toUint8Array(str) {
  if (!str) return new Uint8Array(0);
  const clean = String(str).trim();
  if (/^[0-9a-fA-F]+$/.test(clean) && clean.length % 2 === 0 && !clean.includes("=")) {
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) bytes[i / 2] = parseInt(clean.substr(i, 2), 16);
    return bytes;
  }
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function unpackEnvelope(rawBytes, userKey, aad) {
  if (rawBytes.length === 16 || rawBytes.length === 32) return rawBytes;
  if (rawBytes.length >= 28) {
    const dec = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: rawBytes.subarray(0, 12), additionalData: aad },
      userKey,
      rawBytes.subarray(12)
    );
    return new Uint8Array(dec);
  }
  return rawBytes;
}

export async function decryptM4a(clipId, onProgress) {
  const [meta, rights] = await Promise.all([
    fetchClipMetadata(clipId),
    fetchMangoRights(clipId)
  ]);

  const metadata = meta?.clip || meta?.data?.clip || meta?.data || meta || {};
  const glt = rights.glt || rights.data?.glt || "";
  const keyStr = rights.key || rights.data?.key;
  const ivStr = rights.iv || rights.data?.iv;
  if (!keyStr || !ivStr) throw new Error("Rights payload missing key/iv");

  const userKeyBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(glt || ""));
  const userKey = await crypto.subtle.importKey("raw", userKeyBuf, { name: "AES-GCM" }, false, ["decrypt"]);
  const aad = new TextEncoder().encode(rights.aad || clipId);

  const rawKey = await toUint8Array(keyStr);
  const rawIv = await toUint8Array(ivStr);
  const contentKeyBytes = await unpackEnvelope(rawKey, userKey, aad);
  const contentIvBytes = await unpackEnvelope(rawIv, userKey, aad);

  const counter16 = new Uint8Array(16);
  counter16.set(contentIvBytes.subarray(0, 16));

  const mediaUrl =
    rights.media_url ||
    rights.data?.media_url ||
    rights.url ||
    rights.encrypted_media_url ||
    metadata.media_urls?.find((m) => m.content_type === "m4a-opus")?.url ||
    `${MANGO_CDN}/1/clip/${clipId}.m4a`;

  const resp = await fetch(mediaUrl);
  if (!resp.ok) throw new Error(`Media fetch failed HTTP ${resp.status}`);
  const mediaBuffer = await resp.arrayBuffer();
  onProgress?.(50, mediaBuffer.byteLength, mediaBuffer.byteLength);

  const contentKey = await crypto.subtle.importKey(
    "raw", contentKeyBytes.subarray(0, 32), { name: "AES-CTR" }, false, ["decrypt"]
  );

  try {
    return await crypto.subtle.decrypt({ name: "AES-CTR", counter: counter16, length: 128 }, contentKey, mediaBuffer);
  } catch (_) {
    const counterReset = new Uint8Array(counter16);
    return await crypto.subtle.decrypt({ name: "AES-CTR", counter: counterReset, length: 64 }, contentKey, mediaBuffer);
  }
}

export async function downloadMp3(clipId, meta, onProgress) {
  let mp3Url = null;
  if (meta?.audio_url && typeof meta.audio_url === "string" && meta.audio_url.startsWith("http") && !meta.audio_url.includes("forbidden")) {
    mp3Url = meta.audio_url;
  }
  if (!mp3Url && Array.isArray(meta?.media_urls)) {
    const entry = meta.media_urls.find((m) => (m.content_type || "").toLowerCase().includes("mp3"));
    if (entry?.url && /^https?:/i.test(entry.url)) mp3Url = entry.url;
  }
  if (!mp3Url) throw new Error("No plaintext mp3 source available for this clip");

  const resp = await fetch(mp3Url, { credentials: "include" });
  if (!resp.ok) throw new Error(`mp3 fetch failed HTTP ${resp.status}`);
  const contentType = String(resp.headers.get("content-type") || "").toLowerCase();
  if (!/\.mp3(?:[?#]|$)/i.test(mp3Url) && !/audio\/(mpeg|mp3)/.test(contentType)) throw new Error("Source is not an MP3 file");
  const buf = await resp.arrayBuffer();
  onProgress?.(100, buf.byteLength, buf.byteLength);
  return buf;
}
