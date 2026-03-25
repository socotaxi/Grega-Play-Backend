// services/processVideo.js (ESM)
// V3 COMPLETE (fidèle) : Premium ACTIF (intro/outro custom + musique) + export getVideoJobStatus
// FIX CRITIQUE: premium-assets peut être privé => ne pas utiliser getPublicUrl().
// FIX TRANSITIONS: support des clés UI/schema (modern_1..modern_5) + noms xfade directs.
// FIX BUG: "capabilities is not defined" (watermarkEnabled devait venir du preset, pas d'une variable inexistante)
// ✅ PATCH (2025-12-20): normalize anti-hang
// - débride threads (FFMPEG_THREADS, défaut 0)
// - preset configurable pour normalize (NORMALIZE_PRESET, défaut ultrafast sur Railway)
// - borne durée d'input avec -t (MAX_CLIP_SEC, défaut 35s) même si ffprobe est invalide
// - log durées input pour diagnostic

import path from "path";
import fs from "fs";
import os from "os";
import { exec, spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import { updateVideoJob } from "./db/videoJobs.repo.js";
import https from "https";
import http from "http";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fetch from "cross-fetch";
import { promisify } from "util";
import { runCmdWithTimeout } from "./videoProcessing/ffmpegRunner.js";


const PROCESSVIDEO_BUILD_STAMP =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ||
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
  `local-${new Date().toISOString()}`;

console.log("🧩 processVideo.js build:", PROCESSVIDEO_BUILD_STAMP);

global.fetch = fetch;
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

// ---- Sécurités
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 20 * 60 * 1000);
const FFMPEG_INACTIVITY_MS = Number(process.env.FFMPEG_INACTIVITY_MS || 90 * 1000);
const EXEC_MAX_BUFFER = Number(process.env.EXEC_MAX_BUFFER || 50 * 1024 * 1024);

// ------------------------------------------------------
// ✅ Runtime job map (pour getVideoJobStatus)
// ------------------------------------------------------
const RUNTIME_JOBS = new Map();

function setRuntime(jobId, patch) {
  if (!jobId) return;
  const prev = RUNTIME_JOBS.get(jobId) || {};
  RUNTIME_JOBS.set(jobId, { ...prev, ...patch, updatedAt: new Date().toISOString() });
}

export function getVideoJobStatus(jobId) {
  if (!jobId) return null;
  return RUNTIME_JOBS.get(jobId) || null;
}

// ------------------------------------------------------
// ✅ TRANSITIONS: support UI/schema (modern_1..5) + noms xfade directs
// ------------------------------------------------------
const TRANSITION_MAP = {
  // keys from UI/schema
  modern_1: "fadeblack",
  modern_2: "smoothleft",
  modern_3: "smoothright",
  modern_4: "circleopen",
  modern_5: "pixelize",

  // direct xfade names
  fadeblack: "fadeblack",
  fade: "fade",
  circleopen: "circleopen",
  circleclose: "circleclose",
  pixelize: "pixelize",
  smoothleft: "smoothleft",
  smoothright: "smoothright",
  smoothup: "smoothup",
  smoothdown: "smoothdown",
  wipeleft: "wipeleft",
  wiperight: "wiperight",
  wipeup: "wipeup",
  wipedown: "wipedown",
};

function normalizeEffectivePreset(p) {
  if (!p) return null;
  if (typeof p === "string") {
    try {
      const parsed = JSON.parse(p);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return p && typeof p === "object" ? p : null;
}

function safePreset(p) {
  const obj = p && typeof p === "object" ? p : {};

  const transitionCandidate =
    typeof obj.transition === "string"
      ? obj.transition
      : typeof obj.transition?.value === "string"
        ? obj.transition.value
        : typeof obj.transition?.id === "string"
          ? obj.transition.id
          : typeof obj.transition_key === "string"
            ? obj.transition_key
            : typeof obj.transitionKey === "string"
              ? obj.transitionKey
              : null;

  const transitionRaw = (transitionCandidate || "modern_1").trim();
  const transition = TRANSITION_MAP[transitionRaw] ? transitionRaw : "modern_1";

  const transitionDuration = Math.max(
    0.05,
    Math.min(
      2,
      Number(
        obj.transitionDuration ??
          obj.transition_duration ??
          obj.transition?.duration ??
          obj.transition?.transitionDuration ??
          0.3
      ) || 0.3
    )
  );

  const intro = obj.intro && typeof obj.intro === "object" ? obj.intro : { type: "default" };
  const outro = obj.outro && typeof obj.outro === "object" ? obj.outro : { type: "default" };
  const music = obj.music && typeof obj.music === "object" ? obj.music : { mode: "none" };

  const watermarkObj = obj.watermark && typeof obj.watermark === "object" ? obj.watermark : {};
  const watermark = { enabled: watermarkObj.enabled !== false };

  return { transition, transitionDuration, intro, outro, music, watermark };
}

function resolveTransitionName(presetSafe) {
  const t = presetSafe?.transition;
  return TRANSITION_MAP[t] ? TRANSITION_MAP[t] : "fadeblack";
}

function resolveTransitionDuration(presetSafe) {
  return Math.max(0.05, Math.min(2, Number(presetSafe?.transitionDuration) || 0.3));
}

// ------------------------------------------------------
// Utils logs
// ------------------------------------------------------
function logJson(tag, payload) {
  try {
    console.log(tag, JSON.stringify(payload));
  } catch {
    console.log(tag, payload);
  }
}

// ------------------------------------------------------
// Supabase
// ------------------------------------------------------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant.");
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ------------------------------------------------------
// ✅ parsing args: splitCommand (gère guillemets)
// ------------------------------------------------------
function splitCommand(cmd) {
  const s = String(cmd || "").trim();
  const out = [];
  let cur = "";
  let quote = null;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && i + 1 < s.length) {
        const next = s[i + 1];
        if (next === quote || next === "\\" || next === " ") {
          cur += next;
          i++;
        } else {
          cur += ch;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === " " || ch === "\n" || ch === "\t") {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  if (cur) out.push(cur);
  return out;
}

// ------------------------------------------------------
// Command runner (sans shell)
// ------------------------------------------------------
async function runCmd(cmd, { label = "cmd" } = {}) {
  const parts = splitCommand(cmd);
  const bin = parts[0];
  const args = parts.slice(1);

  if (!bin) throw new Error(`Commande vide (${label})`);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error(`Timeout (${Math.round(FFMPEG_TIMEOUT_MS / 1000)}s) sur ${label}`));
    }, FFMPEG_TIMEOUT_MS);

    child.stdout?.on("data", (c) => {
      const s = c.toString();
      stdout += s;
      stdoutBytes += Buffer.byteLength(s);
      if (stdoutBytes > EXEC_MAX_BUFFER) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    });

    child.stderr?.on("data", (c) => {
      const s = c.toString();
      stderr += s;
      stderrBytes += Buffer.byteLength(s);
      if (stderrBytes > EXEC_MAX_BUFFER) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    });

    child.on("error", (e) => {
      clearTimeout(killTimer);
      reject(e);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) return resolve({ stdout, stderr });
      const tail = String(stderr || stdout).slice(-4000);
      reject(new Error(`Erreur cmd (${label}) code=${code}: ${tail}`));
    });
  });
}

// ------------------------------------------------------
// FFmpeg runner avec progression (sans shell, parsing args)
// ------------------------------------------------------


async function runFfmpegWithProgress(
  cmd,
  {
    jobId,
    step = "ffmpeg",
    label = "ffmpeg",
    totalDurationSec = null,
    progressBase = 0,
    progressSpan = 100,
    message = "",
    expectProgress = false, // true si la commande contient "-progress pipe:2"
    onProgress = null,      // callback optionnel (ws, logs, etc.)
  } = {}
) {
  const safeUpdate = (patch) => {
    if (!jobId) return;

    if (safeUpdate.__noOutTime === true) {
      const { outTimeSec, updatedAt, ...rest } = patch || {};
      return updateVideoJob(jobId, rest).catch((e) =>
        logJson("⚠️ updateVideoJob failed", { jobId, step, error: String(e?.message || e) })
      );
    }

    return updateVideoJob(jobId, patch).catch((e) => {
      const msg = String(e?.message || e);
      if (msg.includes("outTimeSec") || msg.includes("updatedAt")) {
        safeUpdate.__noOutTime = true;
        const { outTimeSec, updatedAt, ...rest } = patch || {};
        return updateVideoJob(jobId, rest).catch((e2) =>
          logJson("⚠️ updateVideoJob failed", { jobId, step, error: String(e2?.message || e2) })
        );
      }
      logJson("⚠️ updateVideoJob failed", { jobId, step, error: msg });
    });
  };

  const base = Math.max(0, Math.min(100, progressBase));
  const span = Math.max(0, Math.min(100, progressSpan));

  safeUpdate({
    status: "processing",
    step,
    progress: base,
    message: message || step,
    error: null,
  });

  setRuntime(jobId, {
    step,
    percent: base,
    totalSec: totalDurationSec ?? null,
  });

  let lastLocal = -1;
  let lastEmit = 0;
  let lastEmittedTsec = 0;

  const emitProgress = (tSec) => {
    if (!totalDurationSec || totalDurationSec <= 0) return;
    if (!Number.isFinite(tSec) || tSec < 0) return;

    // ne jamais reculer (tolérance 250ms)
    if (tSec < lastEmittedTsec - 0.25) return;
    lastEmittedTsec = Math.max(lastEmittedTsec, tSec);

    const tForPercent = Math.min(lastEmittedTsec, totalDurationSec);
    const local = Math.max(0, Math.min(100, Math.round((tForPercent / totalDurationSec) * 100)));

    const now = Date.now();
    if (local === lastLocal) return;
    if (now - lastEmit < 400 && local < 100) return;

    lastLocal = local;
    lastEmit = now;

    const global = Math.max(0, Math.min(100, Math.round(base + (local / 100) * span)));
    const updatedAt = new Date(now).toISOString();

    const timeMsg = `t=${tSec.toFixed(1)}s`;
    const baseMsg = (message || step).trim();
    const mergedMsg = baseMsg ? `${baseMsg} | ${timeMsg}` : timeMsg;

    if (typeof onProgress === "function") {
      try {
        onProgress({
          jobId,
          step,
          progress: global,
          outTimeSec: Number.isFinite(lastEmittedTsec) ? Number(lastEmittedTsec.toFixed(3)) : null,
          updatedAt,
          totalDurationSec,
        });
      } catch (e) {
        logJson("⚠️ onProgress failed", { jobId, step, error: String(e?.message || e) });
      }
    }

    console.log("[PROGRESS_DB]", {
      step,
      progress: global,
      tSec: Number.isFinite(tSec) ? Number(tSec.toFixed(2)) : null,
    });

    safeUpdate({
      status: "processing",
      step,
      progress: global,
      message: mergedMsg,
      outTimeSec: Number.isFinite(tSec) ? Number(tSec.toFixed(3)) : null,
      updatedAt,
    });

    setRuntime(jobId, {
      step,
      percent: global,
      outTimeSec: tSec,
      totalSec: totalDurationSec,
    });
  };

  const { stdout, stderr } = await runCmdWithTimeout(cmd, label, {
    expectProgress: Boolean(expectProgress),
    onProgress: ({ outTimeSec }) => {
      // parsing centralisé: on reçoit outTimeSec (secondes)
      if (Number.isFinite(outTimeSec)) emitProgress(outTimeSec);
    },
  });

  // fin OK: on fixe le step au max de son span
  safeUpdate({
    status: "processing",
    step,
    progress: Math.max(0, Math.min(100, base + span)),
    message: message || step,
    error: null,
  });
  setRuntime(jobId, { step, percent: Math.max(0, Math.min(100, base + span)) });

  return { stdout, stderr };
}


// ------------------------------------------------------
// ffprobe summary
// ------------------------------------------------------
function parseRationalToNumber(val) {
  if (!val || typeof val !== "string") return null;
  const parts = val.split("/");
  if (parts.length !== 2) return null;
  const n = Number(parts[0]);
  const d = Number(parts[1]);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  if (n === 0) return null;
  const out = n / d;
  return Number.isFinite(out) ? out : null;
}

function summarizeProbeStreams(streams = []) {
  const arr = Array.isArray(streams) ? streams : [];
  return arr
    .map((s) => {
      const t = s?.codec_type;

      if (t === "video") {
        const fps = parseRationalToNumber(s.avg_frame_rate) ?? parseRationalToNumber(s.r_frame_rate) ?? null;
        const rotateRaw = s?.tags?.rotate;
        const rotate = rotateRaw != null && rotateRaw !== "" ? Number(rotateRaw) : undefined;

        const out = {
          type: "video",
          codec: s.codec_name,
          w: s.width,
          h: s.height,
          fps: fps != null && fps > 0 ? Number(fps.toFixed(3)) : undefined,
          rotate: Number.isFinite(rotate) ? rotate : undefined,
        };
        Object.keys(out).forEach((k) => (out[k] == null ? delete out[k] : null));
        return out;
      }

      if (t === "audio") {
        const sr = s.sample_rate != null ? Number(s.sample_rate) : undefined;
        const ch = s.channels != null ? Number(s.channels) : undefined;
        const out = {
          type: "audio",
          codec: s.codec_name,
          sr: Number.isFinite(sr) ? sr : undefined,
          ch: Number.isFinite(ch) ? ch : undefined,
        };
        Object.keys(out).forEach((k) => (out[k] == null ? delete out[k] : null));
        return out;
      }

      return null;
    })
    .filter(Boolean);
}

async function probeStreamsSummary(inputPath, { label = "probe" } = {}) {
  try {
    const cmd =
      `ffprobe -v error ` +
      `-show_entries stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels:stream_tags=rotate ` +
      `-of json "${inputPath}"`;
    const { stdout } = await runCmd(cmd, { label: `probeStreamsSummary(${label})` });
    const json = JSON.parse(stdout || "{}");
    const streams = Array.isArray(json.streams) ? json.streams : [];
    return summarizeProbeStreams(streams);
  } catch (e) {
    logJson("❌ ffprobe probeStreamsSummary failed", { label, inputPath, error: String(e?.message || e) });
    return [{ type: "error", error: "probe_failed" }];
  }
}

async function hasAudioStream(inputPath) {
  try {
    const cmd = `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "${inputPath}"`;
    const { stdout } = await runCmd(cmd, { label: "hasAudioStream(ffprobe)" });
    return String(stdout || "").trim() === "audio";
  } catch (e) {
    logJson("⚠️ hasAudioStream(ffprobe) failed", { inputPath, error: String(e?.message || e) });
    return false;
  }
}

async function getVideoDuration(inputPath) {
  const cmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`;
  const { stdout, stderr } = await runCmd(cmd, { label: "getVideoDuration(ffprobe)" });
  const duration = parseFloat(String(stdout || "").trim());
  if (!Number.isFinite(duration)) {
    logJson("❌ ffprobe(duration) invalid", {
      inputPath,
      stdout: String(stdout || "").slice(-400),
      stderr: String(stderr || "").slice(-400),
    });
    throw new Error("Durée vidéo invalide");
  }
  return duration;
}

// ✅ Safe duration (ne throw pas) + log
async function getVideoDurationSafe(inputPath, label = "duration") {
  try {
    const d = await getVideoDuration(inputPath);
    if (Number.isFinite(d)) {
      logJson("⏱️ DURATION", { label, inputPath, durationSec: Number(d.toFixed(3)) });
      return d;
    }
  } catch (e) {
    logJson("⚠️ DURATION_FAILED", { label, inputPath, error: String(e?.message || e) });
  }
  return null;
}

// ------------------------------------------------------
// Download helper (HTTP) pour vidéos publiques
// ------------------------------------------------------
function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(outputPath);

    proto
      .get(url, (response) => {
        if (response.statusCode !== 200) return reject(new Error(`Téléchargement échoué: ${response.statusCode}`));
        response.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        fs.unlink(outputPath, () => reject(err));
      });
  });
}

// ------------------------------------------------------
// ✅ FIX PREMIUM: téléchargement via storage.download() (bucket privé OK)
// + validation simple PNG/MP3/WAV
// ------------------------------------------------------
function isLikelyPng(buf) {
  if (!buf || buf.length < 8) return false;
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

function isLikelyImage(buf) {
  if (!buf || buf.length < 4) return false;
  // PNG
  if (isLikelyPng(buf)) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" &&
      buf.slice(8, 12).toString("ascii") === "WEBP") return true;
  return false;
}

function isLikelyAudio(buf) {
  if (!buf || buf.length < 12) return false;
  const riff = buf.slice(0, 4).toString("ascii");
  const wave = buf.slice(8, 12).toString("ascii");
  if (riff === "RIFF" && wave === "WAVE") return true;

  const id3 = buf.slice(0, 3).toString("ascii");
  if (id3 === "ID3") return true;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;

  return false;
}

async function downloadFromSupabaseBucket(bucket, storagePath, localPath, { expect = "binary" } = {}) {
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error || !data) {
    logJson("❌ supabase.storage.download failed", { bucket, storagePath, error: error?.message || String(error) });
    return false;
  }

  const ab = await data.arrayBuffer();
  const buf = Buffer.from(ab);

  if (expect === "png" && !isLikelyImage(buf)) {
    logJson("❌ premium asset not an image (PNG/JPEG/WebP)", {
      bucket,
      storagePath,
      localPath,
      head: buf.slice(0, 32).toString("hex"),
    });
    return false;
  }

  if (expect === "audio" && !isLikelyAudio(buf)) {
    logJson("❌ premium asset not AUDIO", {
      bucket,
      storagePath,
      localPath,
      head: buf.slice(0, 32).toString("utf8"),
    });
    return false;
  }

  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await fs.promises.writeFile(localPath, buf);
  return fs.existsSync(localPath);
}

async function renderTextToPng(text, outPath) {
  const safe = String(text || "").replace(/'/g, "\\'");
  const cmd =
    `ffmpeg -nostdin -y -f lavfi -i color=c=black:s=720x1280 ` +
    `-vf "drawtext=text='${safe}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2" ` +
    `-frames:v 1 "${outPath}"`;
  await runCmd(cmd, { label: "renderTextToPng" });
  return fs.existsSync(outPath);
}

async function resolveIntroOutroPath(kind, presetPart, tempDir) {
  const fallback =
    kind === "intro"
      ? path.join(__dirname, "assets", "intro.png")
      : path.join(__dirname, "assets", "outro.png");

  const p = presetPart && typeof presetPart === "object" ? presetPart : { type: "default" };
  const type = String(p.type || "default");

  if (type === "custom_image" && p.storagePath) {
    const local = path.join(tempDir, `premium_${kind}_${Date.now()}_${path.basename(p.storagePath)}`);
    if (!fs.existsSync(local)) {
      const ok = await downloadFromSupabaseBucket("premium-assets", p.storagePath, local, { expect: "png" }).catch(
        () => false
      );
      if (!ok) return fallback;
    }
    return fs.existsSync(local) ? local : fallback;
  }

  if (type === "custom_text" && p.text) {
    const local = path.join(tempDir, `premium_${kind}_text_${Date.now()}.png`);
    await renderTextToPng(p.text, local).catch(() => false);
    return fs.existsSync(local) ? local : fallback;
  }

  return fallback;
}

async function resolveMusicPath(musicPreset, tempDir) {
  const m = musicPreset && typeof musicPreset === "object" ? musicPreset : { mode: "none" };
  const mode = String(m.mode || "none");
  if (mode === "none") return null;
  if (!m.storagePath) return null;

  const local = path.join(tempDir, `premium_music_${Date.now()}_${path.basename(m.storagePath)}`);
  if (!fs.existsSync(local)) {
    const ok = await downloadFromSupabaseBucket("premium-assets", m.storagePath, local, { expect: "audio" }).catch(
      () => false
    );
    if (!ok) return null;
  }
  return fs.existsSync(local) ? local : null;
}

// ------------------------------------------------------
// Normalisation robuste
// ------------------------------------------------------
function getNormalizeThreads() {
  const raw = process.env.FFMPEG_THREADS;
  const n = raw ? Number(raw) : NaN;
  // 0 = auto
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function getMaxClipSec() {
  const raw = process.env.MAX_CLIP_SEC;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 35;
}

function getNormalizePreset(isRailway) {
  const raw = String(process.env.NORMALIZE_PRESET || "").trim();
  if (raw) return raw;
  // par défaut: le plus rapide en prod Railway, tout en restant correct
  return isRailway ? "ultrafast" : "veryfast";
}

async function normalizeVideo(
  inputPath,
  outputPath,
  fps = 30,
  { jobId = null, progressBase = 0, progressSpan = 35, label = "normalize", globalIndex = null, isRailway = false } = {}
) {
  const inputHasAudio = await hasAudioStream(inputPath);

  // ✅ Durée + borne anti-hang (capSec doit exister AVANT les filtres)
  const maxClip = getMaxClipSec();
  const dur = await getVideoDurationSafe(inputPath, `input_${globalIndex ?? "x"}`);
  const capSec = Number.isFinite(dur) ? Math.min(dur + 0.5, maxClip) : maxClip;

  // ✅ Threads + preset
  const threads = getNormalizeThreads();
  const preset = getNormalizePreset(isRailway);

  // ✅ Filtres (utilisent capSec)
  const vFilter =
    `settb=AVTB,` +
    `fps=${fps},` +
    `scale=720:1280:force_original_aspect_ratio=decrease,` +
    `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,` +
    `setsar=1,format=yuv420p,` +
    `trim=duration=${capSec},setpts=PTS-STARTPTS`;

  const aFilter =
    `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
    `aresample=48000,` +
    `atrim=duration=${capSec},asetpts=PTS-STARTPTS`;

  let cmd = "";

  if (inputHasAudio) {
    cmd =
      `ffmpeg -nostdin -threads ${threads} -y -fflags +genpts -t ${capSec} -i "${inputPath}" ` +
      `-filter_complex "[0:v]${vFilter}[v];[0:a]${aFilter}[a]" ` +
      `-map "[v]" -map "[a]" ` +
      `-c:v libx264 -preset ${preset} -crf 23 -pix_fmt yuv420p ` +
      `-c:a aac -b:a 128k "${outputPath}"`;
  } else {
    cmd =
      `ffmpeg -nostdin -threads ${threads} -y -fflags +genpts -t ${capSec} -i "${inputPath}" ` +
      `-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000" ` +
      `-filter_complex "[0:v]${vFilter}[v];[1:a]${aFilter}[a]" ` +
      `-map "[v]" -map "[a]" -shortest ` +
      `-c:v libx264 -preset ${preset} -crf 23 -pix_fmt yuv420p ` +
      `-c:a aac -b:a 128k "${outputPath}"`;
  }

  logJson("🧪 NORMALIZE_PARAMS", {
    index: globalIndex,
    inputPath,
    outputPath,
    inputHasAudio,
    durationSec: dur,
    capSec,
    threads,
    preset,
    maxClipSec: maxClip,
    isRailway,
  });

  console.log("➡️ FFmpeg normalize:", cmd);

  const { stderr } = await runFfmpegWithProgress(cmd, {
    jobId,
    step: `normalize_${globalIndex ?? "x"}`,
    label,
    totalDurationSec: capSec, // ✅ basé sur la borne, pas sur dur
    progressBase,
    progressSpan,
    message: "Normalisation en cours...",
  });

  if (stderr) console.log("ℹ️ normalize stderr(tail):", String(stderr).slice(-1200));

  logJson("✅ Vidéo normalisée", { index: globalIndex, outputPath });

  const out = await probeStreamsSummary(outputPath, { label: `normalized_${globalIndex ?? "x"}` });
  logJson("🧾 STREAMS(normalized)", { index: globalIndex, outputPath, streams: out });

  await getVideoDurationSafe(outputPath, `normalized_${globalIndex ?? "x"}`);
}


// ------------------------------------------------------
// Concat xfade + acrossfade
// ------------------------------------------------------
async function runFFmpegFilterConcat(
  processedPaths,
  durations,
  outputPath,
  transition = "fadeblack",
  transitionDuration = 0.3,
  { jobId = null, progressBase = 35, progressSpan = 25 } = {}
) {
  const n = processedPaths.length;
  if (n < 1) throw new Error("Aucune vidéo à concaténer");

  if (n === 1) {
    const cmd = `ffmpeg -nostdin -y -i "${processedPaths[0]}" -c copy "${outputPath}"`;
    await runFfmpegWithProgress(cmd, {
      jobId,
      step: "concat",
      label: "concat(copy)",
      totalDurationSec: durations?.[0] || null,
      progressBase,
      progressSpan,
      message: "Concaténation en cours...",
      expectProgress: true,

    });
    return;
  }

  const offsets = [];
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    acc += Number(durations[i]) || 0;
    offsets.push(Math.max(0, acc - transitionDuration * (i + 1)));
  }

  logJson("🧩 CONCAT_DEBUG", { durations, transition, transitionDuration, offsets });

  const inputs = processedPaths.map((p) => `-i "${p}"`).join(" ");

  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(
        `scale=720:1280:force_original_aspect_ratio=decrease,` +
        `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${i}];` +
        `[${i}:a]asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[a${i}]`
    );
  }

  let vLast = "v0";
  let aLast = "a0";
  for (let i = 1; i < n; i++) {
    const vOut = `v${i}o`;
    const aOut = `a${i}o`;
    const off = offsets[i - 1] ?? 0;
    parts.push(
      `[${vLast}][v${i}]xfade=transition=${transition}:duration=${transitionDuration}:offset=${off}[${vOut}];` +
        `[${aLast}][a${i}]acrossfade=d=${transitionDuration}:c1=tri:c2=tri[${aOut}]`
    );
    vLast = vOut;
    aLast = aOut;
  }

  const filter = parts.join(";");
  const cmd =
    `ffmpeg -nostdin -y ${inputs} ` +
    `-filter_complex "${filter}" ` +
    `-map "[${vLast}]" -map "[${aLast}]" ` +
    `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
    `-c:a aac -b:a 128k "${outputPath}"`;

  const total = (durations || []).reduce((a, b) => a + (Number(b) || 0), 0);

  console.log("➡️ FFmpeg concat+xfade:", cmd);
  await runFfmpegWithProgress(cmd, {
    jobId,
    step: "concat",
    label: "concat+xfade",
    totalDurationSec: total > 0 ? total : null,
    progressBase,
    progressSpan,
    message: "Concaténation en cours...",
    expectProgress: true,
  });
}

// ------------------------------------------------------
// Intro/Outro + musique (premium) + watermark
// ------------------------------------------------------
async function addIntroOutroNoMusic(corePath, outputPath, introPath, outroPath, { jobId, progressBase = 60, progressSpan = 25 } = {}) {
  const introDur = 3;
  const outroDur = 2;
  const coreDur = await getVideoDurationSafe(corePath, "core_for_intro_outro");

  const safeCore = Number.isFinite(coreDur) ? coreDur : 0;
  const targetSec = introDur + safeCore + outroDur;

  const coreHasAudio = await hasAudioStream(corePath);

  // Scale all 3 inputs to same size/format, then concat
  let filter =
    `[0:v]scale=720:1280:force_original_aspect_ratio=decrease,` +
    `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p[v0];` +
    `[1:v]scale=720:1280:force_original_aspect_ratio=decrease,` +
    `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p[v1];` +
    `[2:v]scale=720:1280:force_original_aspect_ratio=decrease,` +
    `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p[v2];` +
    `[v0][v1][v2]concat=n=3:v=1:a=0,trim=duration=${targetSec},setpts=PTS-STARTPTS[v]`;

  let audioMap;
  let silenceArg = "";

  if (coreHasAudio) {
    filter +=
      `;[1:a]adelay=${Math.round(introDur * 1000)}|${Math.round(introDur * 1000)},` +
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000,` +
      `atrim=duration=${targetSec},asetpts=PTS-STARTPTS[a]`;
    audioMap = `-map "[a]"`;
  } else {
    // Input 3: silence (intro=0, core=1, outro=2, silence=3)
    silenceArg = `-f lavfi -t ${Math.ceil(targetSec)} -i "anullsrc=channel_layout=stereo:sample_rate=48000" `;
    audioMap = `-map 3:a`;
  }

  const cmd =
    `ffmpeg -nostdin -y -loop 1 -t ${introDur} -i "${introPath}" ` +
    `-i "${corePath}" -loop 1 -t ${outroDur} -i "${outroPath}" ` +
    `${silenceArg}-filter_complex "${filter}" ` +
    `-map "[v]" ${audioMap} -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "${outputPath}"`;

  console.log("➡️ FFmpeg intro/outro:", cmd);
  await runFfmpegWithProgress(cmd, {
    jobId,
    step: "intro_outro",
    label: "intro_outro",
    totalDurationSec: targetSec,
    progressBase,
    progressSpan,
    message: "Intro/Outro en cours...",
    expectProgress: true,
  });
}

async function addIntroOutroWithMusic(
  corePath,
  outputPath,
  introPath,
  outroPath,
  musicPath,
  musicVolume = 0.6,
  { jobId, progressBase = 60, progressSpan = 25 } = {}
) {
  const introDur = 3;
  const outroDur = 2;

  const coreDur = await getVideoDurationSafe(corePath, "core_for_intro_outro");
  const safeCore = Number.isFinite(coreDur) ? coreDur : 0;
  const targetSec = introDur + safeCore + outroDur;

  const coreHasAudio = await hasAudioStream(corePath);

  // Video: intro + core + outro then trim to targetSec
  let filter =
  `[0:v]scale=720:1280:force_original_aspect_ratio=decrease,` +
  `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,` +
  `fps=30,` +                               // ✅ AJOUT
  `setsar=1,format=yuv420p[v0];` +
  `[1:v]scale=720:1280:force_original_aspect_ratio=decrease,` +
  `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,` +
  `fps=30,` +                               // ✅ AJOUT
  `setsar=1,format=yuv420p[v1];` +
  `[2:v]scale=720:1280:force_original_aspect_ratio=decrease,` +
  `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,` +
  `fps=30,` +                               // ✅ AJOUT
  `setsar=1,format=yuv420p[v2];` +
  `[v0][v1][v2]concat=n=3:v=1:a=0,trim=duration=${targetSec},setpts=PTS-STARTPTS[v];`;

  // Music bed: loop and trim to targetSec
  // note: we use -stream_loop -1 so music always long enough.
  filter +=
    `[3:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000,volume=${Number(musicVolume) || 0.6},atrim=duration=${targetSec},asetpts=PTS-STARTPTS[bed];`;

  if (coreHasAudio) {
      filter +=
      `[1:a]adelay=${Math.round(introDur * 1000)}|${Math.round(introDur * 1000)},` +
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000,` +
      `atrim=duration=${targetSec},asetpts=PTS-STARTPTS[voice];` +
      `[bed][voice]amix=inputs=2:duration=first:dropout_transition=2,atrim=duration=${targetSec},asetpts=PTS-STARTPTS[a]`;
  } else {
    // No core audio: music only
    filter += `[bed]atrim=duration=${targetSec},asetpts=PTS-STARTPTS[a]`;
  }

  const cmd =
    `ffmpeg -nostdin -y ` +
    `-progress pipe:2 ` +
    `-nostats ` +
    `-loop 1 -t ${introDur} -i "${introPath}" ` +
    `-i "${corePath}" ` +
    `-loop 1 -t ${outroDur} -i "${outroPath}" ` +
    `-stream_loop -1 -i "${musicPath}" ` +
    `-filter_complex "${filter}" ` +
    `-map "[v]" -map "[a]" ` +
    `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
    `-c:a aac -b:a 128k -shortest "${outputPath}"`;

  console.log("➡️ FFmpeg intro/outro + music:", cmd);

  await runFfmpegWithProgress(cmd, {
    jobId,
    step: "intro_outro",
    label: "intro_outro",
    totalDurationSec: targetSec,
    progressBase,
    progressSpan,
    message: "Intro/Outro en cours...",
    expectProgress: true,
  });

  logJson("✅ Intro/Outro + music OK", { outputPath });
}



async function applyWatermark(inputPath, outputPath, { jobId, progressBase = 85, progressSpan = 10 } = {}) {
  const watermarkPath = path.join(process.cwd(), "assets", "watermark.png");

  try {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  } catch {}

  if (!fs.existsSync(watermarkPath)) {
    console.warn("⚠️ Watermark introuvable, skip:", watermarkPath);
    await fs.promises.copyFile(inputPath, outputPath);
    return;
  }

// ------------------------------------------------------
// watermark 
// ------------------------------------------------------

  const dur = await getVideoDurationSafe(inputPath, "watermark_input");

  const filterComplex = `[1:v]scale=90:-1[wm];[0:v][wm]overlay=W-w-20:H-h-20:format=auto[v]`;

  const cleanFilterComplex = filterComplex.replace(/\s*\n\s*/g, ' ').trim();


  const cmd =
    `ffmpeg -nostdin -y -i "${inputPath}" -i "${watermarkPath}" ` +
    `-filter_complex "${cleanFilterComplex}" -map "[v]" -map 0:a? ` +
    `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
    `-c:a copy "${outputPath}"`;

  console.log("➡️ FFmpeg watermark:", cmd);
  await runFfmpegWithProgress(cmd, {
    jobId,
    step: "watermark",
    label: "watermark",
    totalDurationSec: dur,
    progressBase,
    progressSpan,
    message: "Watermark en cours...",
    expectProgress: true,
  });
}

// ------------------------------------------------------
// Preset / Event helpers (DB)
// ------------------------------------------------------
function inferIsPremiumEvent(eventRow) {
  if (!eventRow || typeof eventRow !== "object") return false;
  const v =
    eventRow.is_premium ??
    eventRow.is_premium_event ??
    eventRow.is_premium_boosted ??
    eventRow.is_event_premium ??
    eventRow.premium ??
    false;
  return Boolean(v);
}

function pickPresetFromEventRow(eventRow) {
  if (!eventRow || typeof eventRow !== "object") return null;
  const candidates = ["premium_preset", "montage_preset", "video_preset", "preset", "final_preset", "premium_options", "render_preset", "processing_preset"];
  for (const k of candidates) {
    const val = eventRow[k];
    if (val && typeof val === "object") return val;
    if (typeof val === "string" && val.trim()) {
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {}
    }
  }
  return null;
}

// ------------------------------------------------------
// MAIN
// ------------------------------------------------------
export default async function processVideo(eventId, selectedVideoIds, effectivePreset = null, opts = {}) {
  effectivePreset = normalizeEffectivePreset(effectivePreset);

  const jobId = opts?.jobId || null;
  const jobUpdate = (patch) => (jobId ? updateVideoJob(jobId, patch).catch(() => {}) : Promise.resolve());

  try {
    console.log(`🎬 Démarrage montage event=${eventId}`);

    const { error: processingError } = await supabase.from("events").update({ status: "processing" }).eq("id", eventId);
    if (processingError) throw new Error("Impossible de lancer le montage (status processing).");

    let eventRow = null;
    const { data: ev, error: evErr } = await supabase.from("events").select("*").eq("id", eventId).single();
    if (!evErr) eventRow = ev;

    const isPremiumEvent = inferIsPremiumEvent(eventRow);
    const presetFromDb = pickPresetFromEventRow(eventRow);
    const effectivePresetResolved = presetFromDb || effectivePreset || null;

    const proof = safePreset(effectivePresetResolved);

    const watermarkEnabled = proof?.watermark?.enabled !== false;

    logJson("🎛️ PRESET_RESOLVED", {
      isPremiumEvent,
      hasPresetFromDb: Boolean(presetFromDb),
      hasPresetFromParam: Boolean(effectivePreset),
      transition: proof.transition,
      transitionDuration: proof.transitionDuration,
      intro: proof.intro?.type || "default",
      outro: proof.outro?.type || "default",
      music: proof.music?.mode || "none",
      introStoragePath: proof.intro?.storagePath || null,
      outroStoragePath: proof.outro?.storagePath || null,
      musicStoragePath: proof.music?.storagePath || null,
      resolvedTransitionName: resolveTransitionName(proof),
      watermarkEnabled,
    });

    if (!Array.isArray(selectedVideoIds) || selectedVideoIds.length < 2) {
      throw new Error("Au moins 2 vidéos doivent être sélectionnées pour le montage.");
    }

    const { data: videos, error } = await supabase
      .from("videos")
      .select("id, storage_path")
      .eq("event_id", eventId)
      .in("id", selectedVideoIds);

    if (error) throw new Error("Erreur récupération vidéos sélectionnées.");

    const videosToProcess = (videos || []).filter((v) => v.storage_path);
    if (videosToProcess.length < 2) throw new Error("Pas assez de vidéos valides pour lancer le montage.");

    // ✅ temp: /tmp (os.tmpdir()) sur Railway/Linux
    const tempRoot = path.join(os.tmpdir(), "grega-play", "tmp");
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const tempDir = path.join(tempRoot, eventId);
    await fs.promises.mkdir(tempDir, { recursive: true });

    const processedPaths = [];

    const IS_RAILWAY = Boolean(
      process.env.RAILWAY_ENVIRONMENT ||
        process.env.RAILWAY_PROJECT_ID ||
        process.env.RAILWAY_SERVICE_ID ||
        process.env.RAILWAY_GIT_COMMIT_SHA ||
        process.env.RAILWAY_STATIC_URL
    );

    const CONCURRENCY = IS_RAILWAY
      ? 1
      : Math.max(1, Number(process.env.VIDEO_CONCURRENCY || 2));

    for (let i = 0; i < videosToProcess.length; i += CONCURRENCY) {
      const slice = videosToProcess.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async (video, idx) => {
          const globalIndex = i + idx;

          const { publicUrl } = supabase.storage.from("videos").getPublicUrl(video.storage_path).data;
          const localPath = path.join(tempDir, `video${globalIndex}_raw.mp4`);
          const normalizedPath = path.join(tempDir, `video${globalIndex}.mp4`);

          await downloadFile(publicUrl, localPath);

          const inSummary = await probeStreamsSummary(localPath, { label: `input_${globalIndex}` });
          logJson("🧾 STREAMS(input)", { index: globalIndex, inputPath: localPath, streams: inSummary });

          const base = Math.round((globalIndex / Math.max(1, videosToProcess.length)) * 35);
          const span = Math.max(2, Math.round(35 / Math.max(1, videosToProcess.length)));

          await normalizeVideo(localPath, normalizedPath, 30, {
            jobId,
            progressBase: base,
            progressSpan: span,
            label: `normalize_${globalIndex}`,
            globalIndex,
            isRailway: IS_RAILWAY,
          });

          processedPaths[globalIndex] = normalizedPath;
        })
      );
    }

    const orderedProcessed = processedPaths.filter(Boolean);

    const durations = [];
    for (const p of orderedProcessed) durations.push(await getVideoDuration(p));

    const outConcat = path.join(tempDir, "final_concat.mp4");

    await runFFmpegFilterConcat(
      orderedProcessed,
      durations,
      outConcat,
      resolveTransitionName(proof),
      resolveTransitionDuration(proof),
      { jobId, progressBase: 35, progressSpan: 25 }
    );

    const introPath = await resolveIntroOutroPath("intro", proof.intro, tempDir);
    const outroPath = await resolveIntroOutroPath("outro", proof.outro, tempDir);
    const musicPath = await resolveMusicPath(proof.music, tempDir);

    logJson("🧩 PREMIUM_ASSETS_RESOLVED", {
      introPath,
      outroPath,
      musicPath,
      musicMode: proof.music?.mode || "none",
      musicVolume: proof.music?.volume ?? null,
      transitionKey: proof.transition,
      transitionName: resolveTransitionName(proof),
      transitionDuration: resolveTransitionDuration(proof),
      watermarkEnabled,
    });

    const outNoWm = path.join(tempDir, "final_no_wm.mp4");

    console.log("🟡 STEP_START intro_outro", {
      eventId,
      jobId,
      hasMusic: Boolean(musicPath),
    });

    if (musicPath && (proof.music?.mode || "none") !== "none") {
      await addIntroOutroWithMusic(
        outConcat,
        outNoWm,
        introPath,
        outroPath,
        musicPath,
        Number(proof.music?.volume ?? 0.6),
        { jobId, progressBase: 60, progressSpan: 25 }
      );
    } else {
      await addIntroOutroNoMusic(outConcat, outNoWm, introPath, outroPath, {
        jobId,
        progressBase: 60,
        progressSpan: 25,
      });
    }

    logJson("🟢 STEP_DONE intro_outro", {
      eventId,
      jobId,
      output: outNoWm,
      exists: fs.existsSync(outNoWm),
    });

    const outFinal = path.join(tempDir, "final.mp4");

    if (watermarkEnabled) {
      await applyWatermark(outNoWm, outFinal, { jobId, progressBase: 85, progressSpan: 10 });
    } else {
      console.log("🚫 Watermark désactivé par preset. Skip watermark.");
      await fs.promises.copyFile(outNoWm, outFinal);
      await jobUpdate({
        status: "processing",
        step: "watermark",
        message: "Watermark désactivé (skip).",
        error: null,
      });
      setRuntime(jobId, { step: "watermark", percent: 90 });
    }

    if (!fs.existsSync(outFinal)) throw new Error("Vidéo finale introuvable sur disque (final.mp4).");
    await jobUpdate({ status: "processing", step: "upload", progress: 95, message: "Upload vidéo finale...", error: null });
    setRuntime(jobId, { step: "upload", percent: 95 });

    const finalStoragePath = `final_videos/events/${eventId}/final_${Date.now()}.mp4`;
    const buffer = await fs.promises.readFile(outFinal);

    console.log("🟡 UPLOAD_START final_video", {
      eventId,
      jobId,
      storagePath: finalStoragePath,
      fileSize: buffer.length,
    });

    const { error: uploadError } = await supabase.storage.from("videos").upload(finalStoragePath, buffer, {
      contentType: "video/mp4",
      upsert: true,
      cacheControl: "3600",
    });
    if (uploadError) throw new Error(`Erreur upload vidéo finale: ${uploadError.message || "unknown"}`);

    const { data: publicFinal } = supabase.storage.from("videos").getPublicUrl(finalStoragePath);
    const finalVideoUrl = publicFinal?.publicUrl || null;

    const { error: updateErr } = await supabase
      .from("events")
      .update({ status: "done", final_video_url: finalVideoUrl, final_video_path: finalStoragePath })
      .eq("id", eventId);

    if (updateErr) {
      console.error("❌ updateErr details:", JSON.stringify(updateErr));
      throw new Error(`Erreur mise à jour event (final_video_url): ${updateErr.message || updateErr.code || JSON.stringify(updateErr)}`);
    }

    await jobUpdate({ status: "done", step: "done", progress: 100, message: "Vidéo générée", error: null });
    setRuntime(jobId, { step: "done", percent: 100 });

    console.log("🟢 JOB_DONE", {
      eventId,
      jobId,
      finalVideoUrl,
    });

    return { ok: true, finalVideoUrl };
  } catch (e) {
    const errMsg = String(e?.message || e);
    console.error("❌ processVideo failed:", errMsg);

    await jobUpdate({ status: "failed", step: "failed", progress: 100, message: errMsg, error: errMsg });
    setRuntime(jobId, { step: "failed", percent: 100, error: errMsg });

    try {
      await supabase.from("events").update({ status: "failed" }).eq("id", eventId);
    } catch {}

    throw e;
  }
}
