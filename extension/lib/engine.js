// lib/engine.js — Download orchestration (runs in the controls page).
import {
  decryptM4a,
  downloadMp3
} from "./m4a-decrypt.js";
import {
  fetchLibrary,
  fetchLibraryDetailed,
  fetchWorkspaces,
  normalizeClip
} from "./api.js";
import {
  fetchCoverArt,
  fetchClipLyrics,
  buildID3v23Tag,
  injectID3IntoMP3,
  injectMetadataIntoM4A,
  audioBufferToWavBlob,
  detectBpm
} from "./tagging.js";
import {
  getStoredDirHandle,
  writeFile,
  fileExistsName,
  scanDirectoryIndex
} from "./directory.js";
import { interpolateTemplate, isSunoApiUrl } from "./utils.js";
import { dbg } from "./debug.js";

const DOWNLOAD_DIR = "sppe_downloads";

export { fetchLibrary, fetchLibraryDetailed, fetchWorkspaces, normalizeClip };

export function buildFilename(settings, clip, ext) {
  const data = {
    title: clip.title,
    artist: clip.display_name || clip.artist,
    album: "Suno AI Music",
    id: settings.shortId ? clip.id.slice(0, 8) : clip.id,
    shortid: clip.id.slice(0, 8),
    workspace: clip.workspace_id || clip.major_model_version || "library",
    model: clip.major_model_version,
    ext
  };
  const rendered = interpolateTemplate(settings.filenameTemplate, data).replace(/\.{2,}/g, ".");
  return rendered.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? rendered : `${rendered}.${ext}`;
}

export async function resolveDirectoryHandle() {
  const handle = await getStoredDirHandle();
  if (!handle) return null;
  try {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted" ? handle : null;
  } catch (_) {
    return null;
  }
}

async function alreadyDownloaded(settings, clip, filename, directoryHint, knownNames = null) {
  if (settings.downloadMode === "directory") {
    if (knownNames) return knownNames.has(filename.toLowerCase());
    const handle = directoryHint === null ? null : directoryHint || await resolveDirectoryHandle();
    if (handle) return await fileExistsName(handle, filename) || false;
  }
  const key = `downloaded:${clip.id}::${filename}`;
  const rec = await chrome.storage.local.get(key);
  return !!rec[key];
}

export async function isTrackPresent(settings, clip, filename) {
  return alreadyDownloaded(settings, clip, filename);
}

async function markDownloaded(settings, clip, filename) {
  if (settings.downloadMode === "directory") return;
  const key = `downloaded:${clip.id}::${filename}`;
  await chrome.storage.local.set({ [key]: true });
}

async function scanDirectoryForIds(settings, ids) {
  if (settings.downloadMode === "directory") {
    const handle = await resolveDirectoryHandle();
    if (handle) return { ...(await scanDirectoryIndex(handle, ids)), handle };
  }
  return { ids: new Set(), names: new Set(), handle: null };
}

async function fetchDirectAudio(clip, matcher, audioUrlPattern = null) {
  const source = clip?.raw || clip || {};
  const candidates = [];
  if (typeof source.audio_url === "string" && /^https?:/i.test(source.audio_url) && !/forbidden/i.test(source.audio_url) && (!audioUrlPattern || audioUrlPattern.test(source.audio_url))) candidates.push(source.audio_url);
  if (matcher) {
    for (const entry of Array.isArray(source.media_urls) ? source.media_urls : []) {
      if (entry?.url && /^https?:/i.test(entry.url) && matcher(entry)) candidates.push(entry.url);
    }
  }
  for (const url of candidates) {
    if (/m4a-opus|encrypted/i.test(url)) continue;
    try {
      const isApiUrl = isSunoApiUrl(url);
      const response = await fetch(url, { credentials: isApiUrl ? "include" : "omit" });
      if (!response.ok) continue;
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (contentType && !/audio|video\/mp4|application\/octet-stream/.test(contentType)) continue;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 1024) return buffer;
    } catch (_) {}
  }
  return null;
}

async function getAudioForFormat(clip, settings, onProgress) {
  if (settings.audioFormat === "mp3") {
    return { buffer: await downloadMp3(clip.id, clip.raw || clip, onProgress), kind: "array" };
  }
  if (settings.audioFormat === "m4a") {
    const direct = await fetchDirectAudio(clip, (entry) => /audio\/(mp4|m4a|aac)/i.test(String(entry.content_type || entry.type || "")), /\.(m4a|mp4|aac)(?:[?#]|$)/i);
    return { buffer: direct || await decryptM4a(clip.id, onProgress), kind: "array" };
  }
  if (settings.audioFormat === "wav") {
    let src = await fetchDirectAudio(clip, null, /\.(wav|wave)(?:[?#]|$)/i);
    if (!src) src = await decryptM4a(clip.id, onProgress);
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContextCtor();
    try {
      const decoded = await audioCtx.decodeAudioData(src.slice(0));
      return { buffer: decoded, kind: "audio" };
    } finally {
      await audioCtx.close().catch(() => {});
    }
  }
  throw new Error(`Unsupported format: ${settings.audioFormat}`);
}

function hasMp4Container(buffer) {
  const bytes = new Uint8Array(buffer);
  const limit = Math.min(bytes.length, 4096);
  let signature = "";
  for (let index = 0; index < limit; index += 1) signature += String.fromCharCode(bytes[index]);
  return signature.includes("ftyp");
}

async function tagAudio(clip, source, settings, onProgress) {
  const flags = { lyrics: settings.includeLyrics, artwork: settings.embedArtwork };
  let cover = null;
  let lyrics = "";
  if (settings.embedArtwork) cover = await fetchCoverArt(clip).catch(() => null);
  if (settings.includeLyrics) lyrics = await fetchClipLyrics(clip.id, clip).catch(() => "");

  if (settings.audioFormat === "wav") {
    let bpm = null;
    if (settings.detectBpm) bpm = detectBpm(source.buffer);
    let id3Bytes = null;
    if (lyrics || cover || bpm) {
      id3Bytes = buildID3v23Tag(clip, lyrics, bpm, cover, flags);
    }
    return audioBufferToWavBlob(source.buffer, clip, id3Bytes);
  }

  if (settings.audioFormat === "mp3") {
    let bpm = null;
    if (settings.detectBpm) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextCtor();
      try {
        bpm = detectBpm(await audioCtx.decodeAudioData(source.buffer.slice(0)));
      } finally {
        await audioCtx.close().catch(() => {});
      }
    }
    const id3 = buildID3v23Tag(clip, lyrics, bpm, cover, flags);
    const tagged = injectID3IntoMP3(source.buffer, id3);
    return new Blob([tagged], { type: "audio/mpeg" });
  }

  if (settings.audioFormat === "m4a") {
    const buf = await source.buffer.arrayBuffer();
    if (!hasMp4Container(buf)) throw new Error("M4A source is not a valid MP4 container");
    const tagged = injectMetadataIntoM4A(buf, clip, lyrics, cover, flags);
    return new Blob([tagged], { type: "audio/mp4" });
  }

  return new Blob([await source.buffer.arrayBuffer()]);
}

function downloadBlob(blob, filename) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    let downloadId = null;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") finish({ ok: true, id: downloadId });
      if (delta.state?.current === "interrupted") finish({ ok: false, error: "Download interrupted" });
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (id) => {
        const error = chrome.runtime.lastError?.message || null;
        if (error) {
          finish({ ok: false, error });
          return;
        }
        downloadId = id;
        timer = setTimeout(() => finish({ ok: false, error: "Download timed out" }), 600000);
      }
    );
  });
}

async function writeFileOut(settings, directory, filename, blob, onProgress) {
  onProgress?.(100, blob.size, blob.size);
  if (directory && settings.downloadMode === "directory") {
    const path = `${DOWNLOAD_DIR}/${filename}`;
    await writeFile(directory, path, blob);
    return { ok: true, path };
  }
  return downloadBlob(blob, filename);
}

export async function downloadTrack(clip, settings, onProgress, signal, directoryHint, knownNames = null) {
  dbg("downloadTrack", clip.id, "format", settings.audioFormat);
  const ext = settings.audioFormat === "mp3" ? "mp3" : settings.audioFormat === "wav" ? "wav" : "m4a";
  const filename = buildFilename(settings, clip, ext);

  if (signal?.aborted) return { id: clip.id, status: "aborted", filename };
  if (await alreadyDownloaded(settings, clip, filename, directoryHint, knownNames)) {
    return { id: clip.id, status: "skipped", filename, reason: "exists" };
  }

  let directory = settings.downloadMode === "directory" ? (directoryHint === null ? null : directoryHint || await resolveDirectoryHandle()) : null;
  let effectiveSettings = settings;
  if (settings.downloadMode === "directory" && !directory) {
    effectiveSettings = { ...settings, downloadMode: "downloads" };
    dbg("downloadTrack no directory; using browser downloads", clip.id);
  }

  try {
    if (signal?.aborted) return { id: clip.id, status: "aborted", filename };
    const source = await getAudioForFormat(clip, effectiveSettings, onProgress);
    if (signal?.aborted) return { id: clip.id, status: "aborted", filename };
    dbg("downloadTrack audio ready", clip.id, effectiveSettings.audioFormat);
    const blob = await tagAudio(clip, source, effectiveSettings, onProgress);
    if (signal?.aborted) return { id: clip.id, status: "aborted", filename };
    const result = await writeFileOut(effectiveSettings, directory, filename, blob, onProgress);
    if (!result.ok) return { id: clip.id, status: "failed", filename, error: result.error || "Download failed" };
    if (knownNames) knownNames.add(filename.toLowerCase());
    if (effectiveSettings.includeMetadataSidecar) {
      const metaJson = new Blob([JSON.stringify(clip.raw || clip, null, 2)], { type: "application/json" });
      if (effectiveSettings.downloadMode === "directory" && directory) {
        await writeFile(directory, `${DOWNLOAD_DIR}/${filename}.meta.json`, metaJson);
      } else {
        const sidecar = await downloadBlob(metaJson, `${DOWNLOAD_DIR}/${filename}.meta.json`);
        if (!sidecar.ok) return { id: clip.id, status: "failed", filename, error: sidecar.error || "Sidecar download failed" };
      }
    }
    await markDownloaded(effectiveSettings, clip, filename);
    dbg("downloadTrack done", clip.id, filename, result);
    return { id: clip.id, status: "done", filename, ...result };
  } catch (err) {
    dbg("downloadTrack failed", clip.id, err.message);
    return { id: clip.id, status: "failed", filename, error: err.message };
  }
}

export async function downloadBatch(clips, settings, onProgress, signal) {
  const results = new Array(clips.length);
  if (!clips.length) return results;

  if (signal?.aborted) return clips.map((clip) => ({ id: clip.id, status: "aborted" }));
  const ids = clips.map((c) => c.id);
  let directoryIndex;
  try {
    directoryIndex = await scanDirectoryForIds(settings, ids);
  } catch (error) {
    dbg("downloadBatch directory scan failed", error.message);
    directoryIndex = { ids: new Set(), names: new Set(), handle: null };
  }
  const existing = directoryIndex.ids;
  const knownNames = directoryIndex.handle ? directoryIndex.names : null;
  const directory = directoryIndex.handle;
  const queue = [];
  clips.forEach((clip, index) => {
    if (existing.has(clip.id)) results[index] = { id: clip.id, status: "skipped", reason: "exists" };
    else queue.push({ clip, index });
  });

  const concurrency = Math.max(1, Math.min(settings.concurrency || 1, 4));
  let nextIndex = 0;
  let active = 0;

  return new Promise((resolve) => {
    const finish = () => {
      if (active > 0) return;
      if (signal?.aborted) {
        queue.slice(nextIndex).forEach(({ clip, index }) => {
          results[index] = { id: clip.id, status: "aborted" };
        });
      }
      resolve(results);
    };
    const schedule = () => {
      if (signal?.aborted) {
        finish();
        return;
      }
      while (active < concurrency && nextIndex < queue.length) {
        const item = queue[nextIndex++];
        active++;
        downloadTrack(item.clip, settings, (pct, done, totalBytes) => {
          onProgress?.(results, item.index, clips.length, pct, item.clip);
        }, signal, directory, knownNames)
          .then((result) => {
            results[item.index] = result;
            active--;
            schedule();
          })
          .catch((error) => {
            results[item.index] = { id: item.clip.id, status: "failed", error: error.message };
            active--;
            schedule();
          });
      }
      finish();
    };
    schedule();
  });
}
