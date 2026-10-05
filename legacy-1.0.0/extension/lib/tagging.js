// lib/tagging.js — ID3v2.3 (MP3/WAV) and MP4 ilst metadata/embedding.
import { API_BASE, getAuthToken } from "./utils.js";

export async function fetchCoverArt(meta) {
  const url = meta?.image_large_url || meta?.image_url || `https://studio-api-prod.suno.com/api/download/clip/${meta?.id}/cover`;
  if (!url) return null;
  try {
    const r = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const type = r.headers.get("content-type") || "image/jpeg";
    return { buffer: new Uint8Array(buf), mime: type };
  } catch (_) {
    return null;
  }
}

export async function fetchClipLyrics(clipId, meta) {
  const token = await getAuthToken();
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) };
  try {
    const resp = await fetch(`${API_BASE}/api/gen/${clipId}/aligned_lyrics/v3`, {
      credentials: "include",
      headers
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data?.aligned_lyrics && Array.isArray(data.aligned_lyrics)) {
        return data.aligned_lyrics.map((l) => l.text || l.line).filter(Boolean).join("\n");
      }
      if (data?.lyrics) return data.lyrics;
    }
  } catch (_) {}
  return meta?.metadata?.prompt || "";
}

function textEncoder(str) {
  return new TextEncoder().encode(str || "");
}

export function buildID3v23Tag(meta, lyrics = "", bpm = null, coverArt = null, flags = { lyrics: true, artwork: true }) {
  const frames = [];

  const addText = (id, str) => {
    if (!str) return;
    const enc = textEncoder(str);
    const payload = new Uint8Array(1 + enc.length);
    payload[0] = 0x03;
    payload.set(enc, 1);
    frames.push({ id, payload });
  };

  addText("TIT2", meta?.title || "Suno Track");
  addText("TPE1", meta?.display_name || "Suno AI");
  addText("TALB", "Suno AI Music");
  addText("TCON", meta?.metadata?.tags || "AIGC Music");
  addText("TBRC", meta?.major_model_version || "v3");
  addText("TCMP", meta?.id || "");
  if (bpm) addText("TBPM", String(bpm));

  const commentText = `Model: ${meta?.major_model_version || "v3"} | ID: ${meta?.id || ""}\n${meta?.metadata?.prompt || ""}`;
  const encComm = textEncoder(commentText);
  const commPayload = new Uint8Array(1 + 3 + 1 + encComm.length);
  commPayload[0] = 0x03;
  commPayload.set([0x65, 0x6e, 0x67], 1);
  commPayload[4] = 0x00;
  commPayload.set(encComm, 5);
  frames.push({ id: "COMM", payload: commPayload });

  if (lyrics && flags.lyrics) {
    const encLyr = textEncoder(lyrics);
    const usltPayload = new Uint8Array(1 + 3 + 1 + encLyr.length);
    usltPayload[0] = 0x03;
    usltPayload.set([0x65, 0x6e, 0x67], 1);
    usltPayload[4] = 0x00;
    usltPayload.set(encLyr, 5);
    frames.push({ id: "USLT", payload: usltPayload });
  }

  if (coverArt && flags.artwork) {
    const mimeEnc = textEncoder(coverArt.mime || "image/jpeg");
    const apicPayload = new Uint8Array(1 + mimeEnc.length + 1 + 1 + 1 + coverArt.buffer.length);
    let p = 0;
    apicPayload[p++] = 0x03;
    apicPayload.set(mimeEnc, p); p += mimeEnc.length;
    apicPayload[p++] = 0x00;
    apicPayload[p++] = 0x03;
    apicPayload[p++] = 0x00;
    apicPayload.set(coverArt.buffer, p);
    frames.push({ id: "APIC", payload: apicPayload });
  }

  let total = 0;
  for (const f of frames) total += 10 + f.payload.length;

  const tagBytes = new Uint8Array(10 + total);
  tagBytes.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00,
    (total >> 21) & 0x7f, (total >> 14) & 0x7f, (total >> 7) & 0x7f, total & 0x7f], 0);

  let offset = 10;
  const view = new DataView(tagBytes.buffer);
  for (const f of frames) {
    tagBytes[offset] = f.id.charCodeAt(0);
    tagBytes[offset + 1] = f.id.charCodeAt(1);
    tagBytes[offset + 2] = f.id.charCodeAt(2);
    tagBytes[offset + 3] = f.id.charCodeAt(3);
    view.setUint32(offset + 4, f.payload.length, false);
    tagBytes[offset + 8] = 0x00;
    tagBytes[offset + 9] = 0x00;
    tagBytes.set(f.payload, offset + 10);
    offset += 10 + f.payload.length;
  }
  return tagBytes;
}

export function injectID3IntoMP3(mp3Buffer, id3TagBytes) {
  const u8 = new Uint8Array(mp3Buffer);
  let audioStart = 0;
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
    const existingSize =
      ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
    audioStart = 10 + existingSize;
  }
  const combined = new Uint8Array(id3TagBytes.length + (u8.length - audioStart));
  combined.set(id3TagBytes, 0);
  combined.set(u8.subarray(audioStart), id3TagBytes.length);
  return combined.buffer;
}

export function injectMetadataIntoM4A(m4aBuffer, meta, lyrics, coverArt, flags = { lyrics: true, artwork: true }) {
  try {
    const b = new Uint8Array(8 + new Uint8Array(0).length);
    function makeAtom(name, data) {
      const out = new Uint8Array(8 + data.length);
      const v = new DataView(out.buffer);
      v.setUint32(0, out.length, false);
      for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
      out.set(data, 8);
      return out;
    }
    function makeDataAtom(typeCode, payload) {
      const d = new Uint8Array(8 + payload.length);
      const v = new DataView(d.buffer);
      v.setUint32(0, typeCode, false);
      v.setUint32(4, 0, false);
      d.set(payload, 8);
      return makeAtom("data", d);
    }
    function makeTextTag(name, text) {
      if (!text) return new Uint8Array(0);
      const enc = new TextEncoder().encode(text);
      return makeAtom(name, makeDataAtom(1, enc));
    }

    const tags = [];
    tags.push(makeTextTag("©nam", meta?.title || "Suno Track"));
    tags.push(makeTextTag("©ART", meta?.display_name || "Suno AI"));
    tags.push(makeTextTag("©alb", "Suno AI Music"));
    tags.push(makeTextTag("desc", meta?.metadata?.prompt || ""));

    if (lyrics && flags.lyrics) tags.push(makeTextTag("©lyr", lyrics));
    if (coverArt && flags.artwork) {
      const isPng = (coverArt.mime || "").includes("png");
      tags.push(makeAtom("covr", makeDataAtom(isPng ? 14 : 13, coverArt.buffer)));
    }

    let ilstLen = 0;
    for (const t of tags) ilstLen += t.length;
    const ilstPayload = new Uint8Array(ilstLen);
    let off = 0;
    for (const t of tags) { ilstPayload.set(t, off); off += t.length; }
    const ilstAtom = makeAtom("ilst", ilstPayload);
    const metaPayload = new Uint8Array(4 + ilstAtom.length);
    metaPayload.set(ilstAtom, 4);
    const metaAtom = makeAtom("meta", metaPayload);
    const udtaAtom = makeAtom("udta", metaAtom);

    const original = new Uint8Array(m4aBuffer);
    const view = new DataView(m4aBuffer);
    let moovOffset = -1;
    let moovSize = 0;
    let cur = 0;
    while (cur < original.length - 8) {
      const size = view.getUint32(cur, false);
      const type = String.fromCharCode(original[cur + 4], original[cur + 5], original[cur + 6], original[cur + 7]);
      if (type === "moov") { moovOffset = cur; moovSize = size; break; }
      if (size <= 0) break;
      cur += size;
    }
    let mdatOffset = -1;
    let scan = 0;
    while (scan < original.length - 8) {
      const size = view.getUint32(scan, false);
      const type = String.fromCharCode(original[scan + 4], original[scan + 5], original[scan + 6], original[scan + 7]);
      if (type === "mdat") { mdatOffset = scan; break; }
      if (size <= 0) break;
      scan += size;
    }
    if (moovOffset !== -1 && mdatOffset > moovOffset) return m4aBuffer;
    if (moovOffset !== -1) {
      const newMoovSize = moovSize + udtaAtom.length;
      const newBuffer = new Uint8Array(original.length + udtaAtom.length);
      newBuffer.set(original.subarray(0, moovOffset + moovSize), 0);
      newBuffer.set(udtaAtom, moovOffset + moovSize);
      newBuffer.set(original.subarray(moovOffset + moovSize), moovOffset + moovSize + udtaAtom.length);
      new DataView(newBuffer.buffer).setUint32(moovOffset, newMoovSize, false);
      return newBuffer.buffer;
    }
  } catch (e) {
    console.warn("[SunoPower] M4A tag injection warning:", e);
  }
  return m4aBuffer;
}

function createRiffInfoChunk(meta) {
  try {
    const encodeTag = (tag, text) => {
      const enc = new TextEncoder().encode((text || "").slice(0, 500) + "\0");
      const pad = enc.length % 2 !== 0 ? 1 : 0;
      const chunk = new Uint8Array(8 + enc.length + pad);
      for (let i = 0; i < 4; i++) chunk[i] = tag.charCodeAt(i);
      new DataView(chunk.buffer).setUint32(4, enc.length, true);
      chunk.set(enc, 8);
      return chunk;
    };
    const tags = [
      encodeTag("INAM", meta?.title || "Suno Track"),
      encodeTag("IART", meta?.display_name || "Suno AI"),
      encodeTag("IPRD", "Suno AI Music"),
      encodeTag("IGNR", meta?.metadata?.tags || "AIGC Music"),
      encodeTag("ICMT", `Model: ${meta?.major_model_version || "v3"} | Prompt: ${meta?.metadata?.prompt || ""}`)
    ];
    let totalInner = 4;
    for (const t of tags) totalInner += t.length;
    const pad = totalInner % 2 !== 0 ? 1 : 0;
    const listChunk = new Uint8Array(8 + totalInner + pad);
    for (let i = 0; i < 4; i++) listChunk[i] = "LIST".charCodeAt(i);
    new DataView(listChunk.buffer).setUint32(4, totalInner, true);
    for (let i = 0; i < 4; i++) listChunk[8 + i] = "INFO".charCodeAt(i);
    let offset = 12;
    for (const t of tags) { listChunk.set(t, offset); offset += t.length; }
    return listChunk;
  } catch (_) {
    return null;
  }
}

export function audioBufferToWavBlob(decodedBuffer, meta = null, id3ChunkBytes = null) {
  const numChannels = decodedBuffer.numberOfChannels;
  const sampleRate = decodedBuffer.sampleRate;
  let result;
  if (numChannels === 2) {
    const l = decodedBuffer.getChannelData(0);
    const r = decodedBuffer.getChannelData(1);
    result = new Float32Array(l.length + r.length);
    for (let i = 0, idx = 0; i < l.length; i++) { result[idx++] = l[i]; result[idx++] = r[i]; }
  } else {
    result = decodedBuffer.getChannelData(0);
  }
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = result.length * bytesPerSample;

  const infoChunk = meta ? createRiffInfoChunk(meta) : null;
  const infoChunkLen = infoChunk ? infoChunk.length : 0;

  let wavId3Chunk = null;
  if (id3ChunkBytes && id3ChunkBytes.length > 0) {
    const pad = id3ChunkBytes.length % 2 !== 0 ? 1 : 0;
    wavId3Chunk = new Uint8Array(8 + id3ChunkBytes.length + pad);
    for (let i = 0; i < 4; i++) wavId3Chunk[i] = "id3 ".charCodeAt(i);
    new DataView(wavId3Chunk.buffer).setUint32(4, id3ChunkBytes.length, true);
    wavId3Chunk.set(id3ChunkBytes, 8);
  }
  const id3ChunkLen = wavId3Chunk ? wavId3Chunk.length : 0;

  const arrayBuffer = new ArrayBuffer(44 + dataSize + infoChunkLen + id3ChunkLen);
  const view = new DataView(arrayBuffer);
  const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize + infoChunkLen + id3ChunkLen, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < result.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, result[i]));
    s < 0 ? view.setInt16(offset, s * 0x8000, true) : view.setUint16(offset, s * 0x7fff, true);
  }

  const u8 = new Uint8Array(arrayBuffer);
  let extra = 44 + dataSize;
  if (infoChunk) { u8.set(infoChunk, extra); extra += infoChunkLen; }
  if (wavId3Chunk) { u8.set(wavId3Chunk, extra); }

  return new Blob([view], { type: "audio/wav" });
}

export function detectBpm(decodedBuffer) {
  try {
    const sampleRate = decodedBuffer.sampleRate;
    const channelData = decodedBuffer.getChannelData(0);
    const maxSeconds = Math.min(60, decodedBuffer.duration);
    const maxSamples = Math.floor(sampleRate * maxSeconds);
    const downsampleRate = 4410;
    const step = Math.floor(sampleRate / downsampleRate) || 1;
    const len = Math.floor(maxSamples / step);
    const downsampled = new Float32Array(len);
    for (let i = 0, j = 0; i < len; i++, j += step) downsampled[i] = channelData[j];

    const windowSize = Math.floor(downsampleRate * 0.05);
    const energyLen = Math.floor(len / windowSize);
    const energy = new Float32Array(energyLen);
    for (let i = 0; i < energyLen; i++) {
      let sum = 0;
      const start = i * windowSize;
      for (let w = 0; w < windowSize; w++) { const v = downsampled[start + w]; sum += v * v; }
      energy[i] = Math.sqrt(sum / windowSize);
    }

    const minLag = Math.floor((60 / 180) / 0.05);
    const maxLag = Math.floor((60 / 60) / 0.05);
    let bestLag = 0;
    let maxCorr = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0, count = 0;
      for (let i = 0; i < energyLen - lag; i++) { corr += energy[i] * energy[i + lag]; count++; }
      if (count > 0) corr /= count;
      if (corr > maxCorr) { maxCorr = corr; bestLag = lag; }
    }
    if (bestLag > 0 && maxCorr > 0.003) {
      let bpm = Math.round(60 / (bestLag * 0.05));
      while (bpm < 70) bpm *= 2;
      while (bpm > 175) bpm /= 2;
      return Math.round(bpm);
    }
  } catch (_) {}
  return null;
}
