// services/processVideo.js (ESM)
// V3 COMPLETE (fidèle) : Premium ACTIF (intro/outro custom + musique) + export getVideoJobStatus
// FIX CRITIQUE: premium-assets peut être privé => ne pas utiliser getPublicUrl().
// FIX TRANSITIONS: support des clés UI/schema (modern_1..modern_5) + noms xfade directs.
// FIX BUG: "capabilities is not defined" (watermarkEnabled devait venir du preset, pas d'une variable inexistante)

import path from "path";
import fs from "fs";
import { exec, spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import { updateVideoJob } from "./db/videoJobs.repo.js";
import https from "https";
import http from "http";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fetch from "cross-fetch";
import { promisify } from "util";

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

  // transition can come as:
  // - string: "modern_2" or "smoothleft"
  // - object: { value: "modern_2" } or { id: "modern_2" }
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

  // ✅ Watermark (default true)
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
// Command exec helper
// ------------------------------------------------------
async function runCmd(cmd, { label = "cmd" } = {}) {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (e) {
    if (e && (e.killed || String(e.message || "").includes("timed out"))) {
      e.message = `Timeout (${Math.round(FFMPEG_TIMEOUT_MS / 1000)}s) sur ${label}`;
    }
    throw e;
  }
}

// ------------------------------------------------------
// FFmpeg runner avec progression
// ------------------------------------------------------
function parseFfmpegTimeToSeconds(t) {
  if (!t) return null;
  const parts = String(t).trim().split(":");
  if (parts.length < 1 || parts.length > 3) return null;
  const nums = parts.map((x) => Number(x));
  if (nums.some((x) => !Number.isFinite(x))) return null;
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return nums[0];
}

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
  } = {}
) {
  const safeUpdate = (patch) => {
    if (!jobId) return;
    updateVideoJob(jobId, patch).catch((e) =>
      logJson("⚠️ updateVideoJob failed", { jobId, step, error: String(e?.message || e) })
    );
  };

  safeUpdate({
    status: "processing",
    step,
    progress: Math.max(0, Math.min(100, progressBase)),
    message: message || step,
    error: null,
  });

  setRuntime(jobId, {
    step,
    percent: Math.max(0, Math.min(100, progressBase)),
    totalSec: totalDurationSec ?? null,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    let stderrAll = "";
    let stdoutAll = "";
    let lastLocal = -1;
    let lastEmit = 0;

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      const err = new Error(`Timeout FFmpeg (${label}) after ${FFMPEG_TIMEOUT_MS}ms`);
      safeUpdate({ status: "failed", step, progress: 100, message: err.message, error: err.message });
      setRuntime(jobId, { step, percent: 100, error: err.message });
      reject(err);
    }, FFMPEG_TIMEOUT_MS);

    if (child.stdout) child.stdout.on("data", (c) => (stdoutAll += c.toString()));
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const s = chunk.toString();
        stderrAll += s;

        if (!totalDurationSec || totalDurationSec <= 0) return;

        const matches = s.match(/time=\s*([0-9:.]+)/g);
        if (!matches?.length) return;

        const last = matches[matches.length - 1].replace("time=", "").trim();
        const tSec = parseFfmpegTimeToSeconds(last);
        if (tSec == null) return;

        const local = Math.max(0, Math.min(100, Math.round((tSec / totalDurationSec) * 100)));
        const now = Date.now();
        if (local === lastLocal) return;
        if (now - lastEmit < 400 && local < 100) return;

        lastLocal = local;
        lastEmit = now;

        const global = Math.max(0, Math.min(100, Math.round(progressBase + (local / 100) * progressSpan)));
        safeUpdate({ status: "processing", step, progress: global, message: message || step });

        setRuntime(jobId, {
          step,
          percent: global,
          outTimeSec: tSec,
          totalSec: totalDurationSec,
        });
      });
    }

    child.on("error", (err) => {
      clearTimeout(killTimer);
      const msg = err?.message || "ffmpeg error";
      safeUpdate({ status: "failed", step, progress: 100, message: msg, error: msg });
      setRuntime(jobId, { step, percent: 100, error: msg });
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        safeUpdate({
          status: "processing",
          step,
          progress: Math.max(0, Math.min(100, progressBase + progressSpan)),
          message: message || step,
          error: null,
        });
        setRuntime(jobId, { step, percent: Math.max(0, Math.min(100, progressBase + progressSpan)) });
        return resolve({ stdout: stdoutAll, stderr: stderrAll });
      }
      const tail = String(stderrAll || stdoutAll).slice(-4000);
      const msg = `Erreur FFmpeg (${label}) code=${code}: ${tail}`;
      safeUpdate({ status: "failed", step, progress: 100, message: msg, error: msg });
      setRuntime(jobId, { step, percent: 100, error: msg });
      reject(new Error(msg));
    });
  });
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

function getVideoDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        logJson("❌ ffprobe(duration) error", {
          inputPath,
          stderr: String(stderr || "").slice(-1000),
          stdout: String(stdout || "").slice(-1000),
        });
        return reject(new Error("Erreur ffprobe (duration)"));
      }
      const duration = parseFloat(String(stdout).trim());
      if (isNaN(duration)) return reject(new Error("Durée vidéo invalide"));
      resolve(duration);
    });
  });
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

  if (expect === "png" && !isLikelyPng(buf)) {
    logJson("❌ premium asset not PNG", {
      bucket,
      storagePath,
      localPath,
      head: buf.slice(0, 32).toString("utf8"),
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
    `ffmpeg -y -f lavfi -i color=c=black:s=720x1280 ` +
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
      const ok = await downloadFromSupabaseBucket("premium-assets", p.storagePath, local, { expect: "png" }).catch(() => false);
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
    const ok = await downloadFromSupabaseBucket("premium-assets", m.storagePath, local, { expect: "audio" }).catch(() => false);
    if (!ok) return null;
  }
  return fs.existsSync(local) ? local : null;
}

// ------------------------------------------------------
// Normalisation robuste
// ------------------------------------------------------
async function normalizeVideo(
  inputPath,
  outputPath,
  fps = 30,
  { jobId = null, progressBase = 0, progressSpan = 35, label = "normalize", globalIndex = null } = {}
) {
  const inputHasAudio = await hasAudioStream(inputPath);

  const vFilter =
    `settb=AVTB,setpts=PTS-STARTPTS,` +
    `fps=${fps},` +
    `scale=720:1280:force_original_aspect_ratio=decrease,` +
    `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,` +
    `setsar=1,format=yuv420p`;

  const aFilter =
    `asetpts=PTS-STARTPTS,` +
    `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
    `aresample=48000`;

  let cmd = "";
  if (inputHasAudio) {
    cmd =
      `ffmpeg -y -fflags +genpts -i "${inputPath}" ` +
      `-filter_complex "[0:v]${vFilter}[v];[0:a]${aFilter}[a]" ` +
      `-map "[v]" -map "[a]" ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
      `-c:a aac -b:a 128k "${outputPath}"`;
  } else {
    cmd =
      `ffmpeg -y -fflags +genpts -i "${inputPath}" ` +
      `-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000" ` +
      `-filter_complex "[0:v]${vFilter}[v];[1:a]${aFilter}[a]" ` +
      `-map "[v]" -map "[a]" -shortest ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
      `-c:a aac -b:a 128k "${outputPath}"`;
  }

  const dur = await getVideoDuration(inputPath).catch(() => null);

  console.log("➡️ FFmpeg normalize:", cmd);
  const { stderr } = await runFfmpegWithProgress(cmd, {
    jobId,
    step: `normalize_${globalIndex ?? "x"}`,
    label,
    totalDurationSec: dur,
    progressBase,
    progressSpan,
    message: "Normalisation en cours...",
  });
  if (stderr) console.log("ℹ️ normalize stderr(tail):", String(stderr).slice(-1200));

  logJson("✅ Vidéo normalisée", { index: globalIndex, outputPath });
  const out = await probeStreamsSummary(outputPath, { label: `normalized_${globalIndex ?? "x"}` });
  logJson("🧾 STREAMS(normalized)", { index: globalIndex, outputPath, streams: out });
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
    const cmd = `ffmpeg -y -i "${processedPaths[0]}" -c copy "${outputPath}"`;
    await runFfmpegWithProgress(cmd, {
      jobId,
      step: "concat",
      label: "concat(copy)",
      totalDurationSec: durations?.[0] || null,
      progressBase,
      progressSpan,
      message: "Concaténation en cours...",
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
      `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=30,format=yuv420p,` +
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
    `ffmpeg -y ${inputs} ` +
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
  });
}

// ------------------------------------------------------
// Intro/Outro + musique (premium) + watermark
// ------------------------------------------------------
async function addIntroOutroNoMusic(corePath, outputPath, introPath, outroPath, { jobId, progressBase = 60, progressSpan = 25 } = {}) {
  const introDur = 3;
  const outroDur = 2;
  const coreDur = await getVideoDuration(corePath).catch(() => null);
  const totalDur = introDur + (coreDur || 0) + outroDur || null;

  const coreHasAudio = await hasAudioStream(corePath);

  const silenceInput = `-f lavfi -t ${Math.max(1, Math.ceil(totalDur || 6))} -i "anullsrc=channel_layout=stereo:sample_rate=48000"`;

  let filter;
  if (coreHasAudio) {
    filter =
      `[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v0];` +
      `[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v1];` +
      `[2:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v2];` +
      `[v0][v1][v2]concat=n=3:v=1:a=0[v];` +
      `[1:a]adelay=3000|3000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[voice];` +
      `[3:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[bed];` +
      `[bed][voice]amix=inputs=2:duration=first:dropout_transition=2[a]`;
  } else {
    filter =
      `[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v0];` +
      `[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v1];` +
      `[2:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v2];` +
      `[v0][v1][v2]concat=n=3:v=1:a=0[v];` +
      `[3:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[a]`;
  }

  const cmd =
    `ffmpeg -y -loop 1 -t ${introDur} -i "${introPath}" ` +
    `-i "${corePath}" -loop 1 -t ${outroDur} -i "${outroPath}" ` +
    `${silenceInput} -filter_complex "${filter}" ` +
    `-map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "${outputPath}"`;

  console.log("➡️ FFmpeg intro/outro:", cmd);
  await runFfmpegWithProgress(cmd, {
    jobId,
    step: "intro_outro",
    label: "intro_outro",
    totalDurationSec: totalDur,
    progressBase,
    progressSpan,
    message: "Intro/Outro en cours...",
  });
}

async function addIntroOutroWithMusic(
  corePath,
  outputPath,
  introPath,
  outroPath,
  musicPath,
  musicVolume,
  { jobId, progressBase = 60, progressSpan = 25 } = {}
) {
  const introDur = 3;
  const outroDur = 2;
  const coreDur = await getVideoDuration(corePath).catch(() => null);
  const totalDur = introDur + (coreDur || 0) + outroDur || null;

  const coreHasAudio = await hasAudioStream(corePath);

  const silenceInput = `-f lavfi -t ${Math.max(1, Math.ceil(totalDur || 6))} -i "anullsrc=channel_layout=stereo:sample_rate=48000"`;
  const musicInput = `-stream_loop -1 -i "${musicPath}"`;

  const vol = Number.isFinite(Number(musicVolume)) ? Number(musicVolume) : 0.6;

  let filter = "";

  filter +=
    `[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v0];` +
    `[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v1];` +
    `[2:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v2];` +
    `[v0][v1][v2]concat=n=3:v=1:a=0[v];`;

  filter +=
    `[4:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000,` +
    `volume=${vol},atrim=0:${Math.max(1, Number(totalDur || 6))}[music];`;

  filter +=
    `[3:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[bed];`;

  if (coreHasAudio) {
    filter +=
      `[1:a]adelay=${introDur * 1000}|${introDur * 1000},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[voice];` +
      `[bed][voice][music]amix=inputs=3:duration=first:dropout_transition=2[a]`;
  } else {
    filter +=
      `[bed][music]amix=inputs=2:duration=shortest[a]`;
  }

  const cmd =
    `ffmpeg -y -loop 1 -t ${introDur} -i "${introPath}" ` +
    `-i "${corePath}" -loop 1 -t ${outroDur} -i "${outroPath}" ` +
    `${silenceInput} ${musicInput} ` +
    `-filter_complex "${filter}" ` +
    `-map "[v]" -map "[a]" ` +
    `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "${outputPath}"`;

  console.log("➡️ FFmpeg intro/outro + music:", cmd);
  await runFfmpegWithProgress(cmd, {
    jobId,
    step: "intro_outro",
    label: "intro_outro_music",
    totalDurationSec: totalDur,
    progressBase,
    progressSpan,
    message: "Intro/Outro + musique en cours...",
  });
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

  const dur = await getVideoDuration(inputPath).catch(() => null);

  const filterComplex = `[1:v]scale=150:-1[wm];[0:v][wm]overlay=W-w-20:H-h-20:format=auto[v]`;

  const cmd =
    `ffmpeg -y -i "${inputPath}" -i "${watermarkPath}" ` +
    `-filter_complex "${filterComplex}" -map "[v]" -map 0:a? ` +
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

    // ✅ FIX: watermarkEnabled doit venir DU PRESET (proof.watermark.enabled)
    // (pas d'une variable "capabilities" ou "userChoice" inexistante)
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

    const tempRoot = path.join(__dirname, "tmp");
    if (!fs.existsSync(tempRoot)) fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = path.join(tempRoot, eventId);
    fs.mkdirSync(tempDir, { recursive: true });

    const processedPaths = [];
    const CONCURRENCY = 2;

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

    // ✅ PREMIUM: resolve intro/outro/music
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

    // ✅ Watermark conditional (sans ReferenceError)
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

    if (updateErr) throw new Error("Erreur mise à jour event (final_video_url).");

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
