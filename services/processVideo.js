// services/processVideo.js (ESM)
// Updated: stream summary propre, logs JSON lisibles Railway, gestion audio absent,
// statut failed + error, progression FFmpeg sur commandes critiques.
// IMPORTANT: aucune dépendance à videoPreset.schema.js (évite crash Railway).

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

global.fetch = fetch;
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

// ---- Build stamp (utile pour vérifier que Railway exécute bien CE fichier)
const BUILD_STAMP_PROCESSVIDEO =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  `local-${Date.now()}`;
console.log("🧩 processVideo.js build:", BUILD_STAMP_PROCESSVIDEO);

// ---- Sécurités
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 20 * 60 * 1000); // 20 min
const EXEC_MAX_BUFFER = Number(process.env.EXEC_MAX_BUFFER || 50 * 1024 * 1024); // 50MB

// ------------------------------------------------------
// PRESET minimal inline (remplace videoPreset.schema.js)
// ------------------------------------------------------
const TRANSITION_MAP = {
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
  const transitionRaw = typeof obj.transition === "string" ? obj.transition : "fadeblack";
  const transition = TRANSITION_MAP[transitionRaw] ? transitionRaw : "fadeblack";
  const transitionDuration = Math.max(
    0.05,
    Math.min(2, Number(obj.transitionDuration ?? obj.transition_duration ?? 0.3) || 0.3)
  );

  const intro = obj.intro && typeof obj.intro === "object" ? obj.intro : { type: "default" };
  const outro = obj.outro && typeof obj.outro === "object" ? obj.outro : { type: "default" };
  const music = obj.music && typeof obj.music === "object" ? obj.music : { mode: "none" };

  return { transition, transitionDuration, intro, outro, music };
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
  // 1 JSON par ligne => Railway lisible même avec plusieurs jobs
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
// Command exec helper (avec timeout / buffer)
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
// FFmpeg runner avec progression (stderr time=...)
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
      });
    }

    child.on("error", (err) => {
      clearTimeout(killTimer);
      const msg = err?.message || "ffmpeg error";
      safeUpdate({ status: "failed", step, progress: 100, message: msg, error: msg });
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
        return resolve({ stdout: stdoutAll, stderr: stderrAll });
      }
      const tail = String(stderrAll || stdoutAll).slice(-4000);
      const msg = `Erreur FFmpeg (${label}) code=${code}: ${tail}`;
      safeUpdate({ status: "failed", step, progress: 100, message: msg, error: msg });
      reject(new Error(msg));
    });
  });
}

// ------------------------------------------------------
// ffprobe: stream summary propre (type-specific)
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
        const out = { type: "audio", codec: s.codec_name, sr: Number.isFinite(sr) ? sr : undefined, ch: Number.isFinite(ch) ? ch : undefined };
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
// Download helper
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
// Normalisation robuste (audio absent => piste silencieuse)
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

  console.log("✅ Vidéo normalisée:", outputPath);
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
// Intro/Outro (simple + audio bed) + watermark (critique)
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
      `[1:a]adelay=${introDur * 1000}|${introDur * 1000},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[voice];` +
      `[3:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[bed];` +
      `[bed][voice]amix=inputs=2:duration=longest[a]`;
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
    `-map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k "${outputPath}"`;

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

async function applyWatermark(inputPath, outputPath, { jobId, progressBase = 85, progressSpan = 10 } = {}) {
  const watermarkPath = path.join(process.cwd(), "assets", "watermark.png");
  if (!fs.existsSync(watermarkPath)) {
    console.warn("⚠️ Watermark introuvable, skip:", watermarkPath);
    await fs.promises.copyFile(inputPath, outputPath);
    return;
  }

  const dur = await getVideoDuration(inputPath).catch(() => null);
  const filter = `movie='${watermarkPath}':loop=0,scale=150:-1[wm];[0:v][wm]overlay=W-w-20:H-h-20:format=auto`;

  const cmd =
    `ffmpeg -y -i "${inputPath}" -vf "${filter}" ` +
    `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a copy "${outputPath}"`;

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

    // event -> processing
    const { error: processingError } = await supabase.from("events").update({ status: "processing" }).eq("id", eventId);
    if (processingError) throw new Error("Impossible de lancer le montage (status processing).");

    // load event
    let eventRow = null;
    const { data: ev, error: evErr } = await supabase.from("events").select("*").eq("id", eventId).single();
    if (!evErr) eventRow = ev;

    const isPremiumEvent = inferIsPremiumEvent(eventRow);
    const presetFromDb = pickPresetFromEventRow(eventRow);
    const effectivePresetResolved = presetFromDb || effectivePreset || null;

    const proof = safePreset(effectivePresetResolved);
    logJson("🎛️ PRESET_RESOLVED", {
      isPremiumEvent,
      hasPresetFromDb: Boolean(presetFromDb),
      hasPresetFromParam: Boolean(effectivePreset),
      transition: proof.transition,
      transitionDuration: proof.transitionDuration,
      intro: proof.intro?.type || "default",
      outro: proof.outro?.type || "default",
      music: proof.music?.mode || "none",
    });

    if (!Array.isArray(selectedVideoIds) || selectedVideoIds.length < 2) {
      throw new Error("Au moins 2 vidéos doivent être sélectionnées pour le montage.");
    }

    // fetch selected videos
    const { data: videos, error } = await supabase
      .from("videos")
      .select("id, storage_path")
      .eq("event_id", eventId)
      .in("id", selectedVideoIds);

    if (error) throw new Error("Erreur récupération vidéos sélectionnées.");

    const videosToProcess = (videos || []).filter((v) => v.storage_path);
    if (videosToProcess.length < 2) throw new Error("Pas assez de vidéos valides pour lancer le montage.");

    // tmp
    const tempRoot = path.join(__dirname, "tmp");
    if (!fs.existsSync(tempRoot)) fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = path.join(tempRoot, eventId);
    fs.mkdirSync(tempDir, { recursive: true });

    // normalize in small concurrency
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

    // durations
    const durations = [];
    for (const p of orderedProcessed) durations.push(await getVideoDuration(p));

    // concat
    const outConcat = path.join(tempDir, "final_concat.mp4");
    const presetForConcat = safePreset(effectivePresetResolved);

    await runFFmpegFilterConcat(
      orderedProcessed,
      durations,
      outConcat,
      resolveTransitionName(presetForConcat),
      resolveTransitionDuration(presetForConcat),
      { jobId, progressBase: 35, progressSpan: 25 }
    );

    // intro/outro (simple)
    const introPath = path.join(__dirname, "assets", "intro.png");
    const outroPath = path.join(__dirname, "assets", "outro.png");
    const outNoWm = path.join(tempDir, "final_no_wm.mp4");

    await addIntroOutroNoMusic(outConcat, outNoWm, introPath, outroPath, { jobId, progressBase: 60, progressSpan: 25 });

    // watermark
    const outFinal = path.join(tempDir, "final.mp4");
    await applyWatermark(outNoWm, outFinal, { jobId, progressBase: 85, progressSpan: 10 });

    // upload
    if (!fs.existsSync(outFinal)) throw new Error("Vidéo finale introuvable sur disque (final.mp4).");
    await jobUpdate({ status: "processing", step: "upload", progress: 95, message: "Upload vidéo finale...", error: null });

    const finalStoragePath = `final_videos/events/${eventId}/final_${Date.now()}.mp4`;
    const buffer = await fs.promises.readFile(outFinal);

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
    return { ok: true, finalVideoUrl };
  } catch (e) {
    const errMsg = String(e?.message || e);
    console.error("❌ processVideo failed:", errMsg);

    await jobUpdate({ status: "failed", step: "failed", progress: 100, message: errMsg, error: errMsg });

    // best-effort: event failed
    try {
      await supabase.from("events").update({ status: "failed" }).eq("id", eventId);
    } catch {}

    throw e;
  }
}
