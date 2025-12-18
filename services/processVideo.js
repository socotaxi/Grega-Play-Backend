import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { spawn } from "child_process";
import { promisify } from "util";
import { createClient } from "@supabase/supabase-js";
import { updateVideoJob } from "./db/videoJobs.repo.js";

import {
  TRANSITION_MAP,
  safePreset,
  resolveTransitionName,
  resolveTransitionDuration,
  normalizeEffectivePreset,
} from "./videoPreset.schema.js";

const execAsync = promisify(exec);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 10 * 60_000);
const NORMALIZE_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.NORMALIZE_CONCURRENCY || 2))
);

function sanitizeFilename(s) {
  return String(s || "").replace(/[^a-z0-9_-]/gi, "_");
}

function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

function safeMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

async function runCmd(cmd, { label = "cmd", timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { stdout, stderr, ms: Date.now() - startedAt };
  } catch (err) {
    const tail = String(err?.stderr || err?.stdout || err?.message || "").slice(-4000);
    console.error(`❌ ${label} failed:`, tail);
    throw err;
  }
}

// ------------------------------------------------------
// ✅ FFmpeg runner with real-time progress (stderr time=...)
// ------------------------------------------------------
function parseFfmpegTimeToSeconds(t) {
  // Supports "HH:MM:SS.xx" or "MM:SS.xx"
  if (!t) return null;
  const parts = String(t).trim().split(":").map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
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
  const timeoutMs = FFMPEG_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const safeUpdate = (patch) => {
      if (!jobId) return;
      updateVideoJob(jobId, patch).catch((e) => {
        console.warn(
          "⚠️ updateVideoJob failed:",
          JSON.stringify({ jobId, step, error: String(e?.message || e) })
        );
      });
    };

    safeUpdate({
      status: "processing",
      step,
      progress: Math.max(0, Math.min(100, progressBase)),
      message: message || step,
      error: null,
    });

    const child = spawn(cmd, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutAll = "";
    let stderrAll = "";
    let lastLocalPercent = -1;
    let lastEmitAt = 0;

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      const err = new Error(`Timeout FFmpeg (${label}) after ${timeoutMs}ms`);
      safeUpdate({
        status: "failed",
        step,
        progress: Math.max(0, Math.min(100, progressBase + progressSpan)),
        message: err.message,
        error: err.message,
      });
      reject(err);
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on("data", (c) => {
        stdoutAll += c.toString();
      });
    }

    const onStderr = (chunk) => {
      const s = chunk.toString();
      stderrAll += s;

      if (!totalDurationSec || totalDurationSec <= 0) return;

      // Parse time=00:00:10.38 (can appear multiple times)
      const matches = s.match(/time=\s*([0-9:.]+)/g);
      if (!matches || matches.length === 0) return;

      const last = matches[matches.length - 1];
      const tStr = last.replace("time=", "").trim();
      const tSec = parseFfmpegTimeToSeconds(tStr);
      if (tSec == null) return;

      const local = Math.max(
        0,
        Math.min(100, Math.round((tSec / totalDurationSec) * 100))
      );

      const now = Date.now();
      if (local === lastLocalPercent) return;
      if (now - lastEmitAt < 400 && local < 100) return;

      lastLocalPercent = local;
      lastEmitAt = now;

      const global = Math.max(
        0,
        Math.min(100, Math.round(progressBase + (local / 100) * progressSpan))
      );

      safeUpdate({
        status: "processing",
        step,
        progress: global,
        message: message || step,
      });
    };

    if (child.stderr) child.stderr.on("data", onStderr);

    child.on("error", (err) => {
      clearTimeout(killTimer);
      const msg = err?.message || "ffmpeg error";
      safeUpdate({
        status: "failed",
        step,
        progress: Math.max(0, Math.min(100, progressBase)),
        message: msg,
        error: msg,
      });
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
        });
        return resolve({
          stdout: stdoutAll,
          stderr: stderrAll,
          ms: Date.now() - startedAt,
        });
      }

      const tail = String(stderrAll || stdoutAll).slice(-4000);
      const msg = `Erreur FFmpeg (${label}) code=${code}: ${tail}`;
      safeUpdate({
        status: "failed",
        step,
        progress: Math.max(0, Math.min(100, progressBase + progressSpan)),
        message: msg,
        error: msg,
      });
      reject(new Error(msg));
    });
  });
}

// ------------------------------------------------------
// ✅ ffprobe helpers
// ------------------------------------------------------
function parseRationalToNumber(val) {
  // "30/1" -> 30 ; "0/0" or invalid -> null
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
        const fps =
          parseRationalToNumber(s.avg_frame_rate) ??
          parseRationalToNumber(s.r_frame_rate) ??
          null;
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

async function hasAudioStream(inputPath) {
  try {
    const cmd = `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "${inputPath}"`;
    const { stdout } = await runCmd(cmd, { label: "hasAudioStream(ffprobe)" });
    return String(stdout || "").trim() === "audio";
  } catch (e) {
    console.warn("⚠️ hasAudioStream(ffprobe) failed:", JSON.stringify({ inputPath, error: String(e?.message || e) }));
    return false;
  }
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
    console.error("❌ ffprobe probeStreamsSummary failed:", JSON.stringify({ label, inputPath, error: String(e?.message || e) }));
    return [{ type: "error", error: "probe_failed" }];
  }
}

function logStreamsJson(tag, payload) {
  // Railway logs are easier to read with one JSON string per line
  try {
    console.log(tag, JSON.stringify(payload));
  } catch {
    console.log(tag, payload);
  }
}

function getVideoDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ ffprobe error:", stderr || stdout);
        return reject(new Error("Erreur ffprobe (duration)"));
      }
      const duration = parseFloat(String(stdout).trim());
      if (isNaN(duration)) return reject(new Error("Durée vidéo invalide"));
      resolve(duration);
    });
  });
}

// ------------------------------------------------------
// ✅ Normalisation
// ------------------------------------------------------
async function normalizeVideo(
  inputPath,
  outputPath,
  fps = 30,
  { jobId = null, progressBase = 0, progressSpan = 35, label = "normalize", globalIndex = null } = {}
) {
  const hasAudio = await hasAudioStream(inputPath);

  const base = hasAudio
    ? `-i "${inputPath}" -vf "fps=${fps},scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -ar 48000 -ac 2`
    : `-i "${inputPath}" -vf "fps=${fps},scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p" -c:v libx264 -preset veryfast -crf 23 -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000" -shortest -c:a aac -b:a 128k -ar 48000 -ac 2`;

  const cmd = `ffmpeg -y ${base} "${outputPath}"`;

  console.log("➡️ Normalize cmd:", cmd);

  const durationSec = await getVideoDuration(inputPath).catch(() => null);

  const { stderr } = await runFfmpegWithProgress(cmd, {
    jobId,
    step: `normalize_${globalIndex ?? ""}`,
    label,
    totalDurationSec: durationSec,
    progressBase,
    progressSpan,
    message: "Normalisation en cours...",
  });

  if (stderr) console.log("ℹ️ FFmpeg normalize stderr (tail):", String(stderr).slice(-2000));
  console.log("✅ Vidéo normalisée:", outputPath);

  const outStreams = await probeStreamsSummary(outputPath, { label: `normalized_${globalIndex ?? "x"}` });
  logStreamsJson("🧾 STREAMS(normalized)", { index: globalIndex, outputPath, streams: outStreams });
}

// ------------------------------------------------------
// ✅ Concat
// ------------------------------------------------------
async function runFFmpegFilterConcat(
  processedPaths,
  durations,
  outputPath,
  transition = "fadeblack",
  transitionDuration = 0.3,
  { jobId = null, progressBase = 35, progressSpan = 25 } = {}
) {
  if (!processedPaths || processedPaths.length < 1) {
    throw new Error("Aucune vidéo à concaténer");
  }
  if (processedPaths.length === 1) {
    const cmd = `ffmpeg -y -i "${processedPaths[0]}" -c copy "${outputPath}"`;
    console.log("➡️ FFmpeg concat (single, copy):", cmd);
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

  const n = processedPaths.length;

  const offsets = [];
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = Number(durations[i]) || 0;
    acc += d;
    offsets.push(Math.max(0, acc - transitionDuration * (i + 1)));
  }

  console.log("🧩 CONCAT DEBUG durations:", durations);
  console.log("🧩 CONCAT DEBUG transition:", transition, "dur:", transitionDuration, "offsets:", offsets);

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

  console.log("➡️ FFmpeg concat+xfade:", cmd);

  const total = (durations || []).reduce((a, b) => a + (Number(b) || 0), 0);
  await runFfmpegWithProgress(cmd, {
    jobId,
    step: "concat",
    label: "concat+xfade",
    totalDurationSec: total > 0 ? total : null,
    progressBase,
    progressSpan,
    message: "Concaténation en cours...",
  });

  console.log("✅ Concat terminé:", outputPath);
}

// ------------------------------------------------------
// ✅ Intro / Outro + Music options
// ------------------------------------------------------
function addIntroOutroNoMusic(introPath, corePath, outroPath, outputPath, { jobId = null, progressBase = 60, progressSpan = 25 } = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const introDur = 3;
      const outroDur = 2;
      const coreDur = await getVideoDuration(corePath).catch(() => null);
      const totalDur = (introDur + (coreDur || 0) + outroDur) || null;

      const coreHasAudio = await hasAudioStream(corePath);

      const silenceInput = `-f lavfi -t ${Math.max(1, Math.ceil(totalDur || 6))} -i "anullsrc=channel_layout=stereo:sample_rate=48000"`;

      let filter;
      if (coreHasAudio) {
        filter =
          `[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v0]; ` +
          `[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v1]; ` +
          `[2:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v2]; ` +
          `[v0][v1][v2]concat=n=3:v=1:a=0[v]; ` +
          `[1:a]adelay=${introDur * 1000}|${introDur * 1000},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[voice]; ` +
          `[3:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[sil]; ` +
          `[sil][voice]amix=inputs=2:duration=longest[a]`;
      } else {
        filter =
          `[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v0]; ` +
          `[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v1]; ` +
          `[2:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v2]; ` +
          `[v0][v1][v2]concat=n=3:v=1:a=0[v]; ` +
          `[3:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[a]`;
      }

      const cmd =
        `ffmpeg -y ` +
        `-loop 1 -t ${introDur} -i "${introPath}" ` +
        `-i "${corePath}" ` +
        `-loop 1 -t ${outroDur} -i "${outroPath}" ` +
        `${silenceInput} ` +
        `-filter_complex "${filter}" ` +
        `-map "[v]" -map "[a]" ` +
        `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
        `-c:a aac -b:a 128k "${outputPath}"`;

      console.log("➡️ FFmpeg intro/outro (no music):", cmd);

      await runFfmpegWithProgress(cmd, {
        jobId,
        step: "intro_outro",
        label: "intro/outro(no-music)",
        totalDurationSec: totalDur,
        progressBase,
        progressSpan,
        message: "Intro/Outro en cours...",
      });

      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

function addIntroOutroFullMusic(
  introPath,
  corePath,
  outroPath,
  musicPath,
  outputPath,
  { jobId = null, progressBase = 60, progressSpan = 25, musicVolume = 0.6, ducking = false } = {}
) {
  return new Promise(async (resolve, reject) => {
    try {
      const introDur = 3;
      const outroDur = 2;
      const coreDur = await getVideoDuration(corePath).catch(() => null);
      const totalDur = (introDur + (coreDur || 0) + outroDur) || null;

      const coreHasAudio = await hasAudioStream(corePath);

      const silenceInput = `-f lavfi -t ${Math.max(1, Math.ceil(totalDur || 6))} -i "anullsrc=channel_layout=stereo:sample_rate=48000"`;

      const voiceChain = coreHasAudio
        ? `[1:a]adelay=${introDur * 1000}|${introDur * 1000},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[voice]; `
        : "";

      const baseSilence = `[4:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[bed]; `;
      const musicChain =
        `[3:a]volume=${musicVolume},atrim=0:${(totalDur || 0).toFixed(3)},asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[music]; `;

      let audioMix;
      if (coreHasAudio) {
        if (ducking) {
          audioMix =
            `${voiceChain}${baseSilence}${musicChain}` +
            `[music][voice]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=250[musicduck]; ` +
            `[bed][voice][musicduck]amix=inputs=3:duration=longest[a]`;
        } else {
          audioMix =
            `${voiceChain}${baseSilence}${musicChain}` +
            `[bed][voice][music]amix=inputs=3:duration=longest[a]`;
        }
      } else {
        audioMix = `${baseSilence}${musicChain}[bed][music]amix=inputs=2:duration=longest[a]`;
      }

      const filter =
        `[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v0]; ` +
        `[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v1]; ` +
        `[2:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v2]; ` +
        `[v0][v1][v2]concat=n=3:v=1:a=0[v]; ` +
        audioMix;

      const cmd =
        `ffmpeg -y ` +
        `-loop 1 -t ${introDur} -i "${introPath}" ` +
        `-i "${corePath}" ` +
        `-loop 1 -t ${outroDur} -i "${outroPath}" ` +
        `-stream_loop -1 -i "${musicPath}" ` +
        `${silenceInput} ` +
        `-filter_complex "${filter}" ` +
        `-map "[v]" -map "[a]" ` +
        `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
        `-c:a aac -b:a 128k "${outputPath}"`;

      console.log("➡️ FFmpeg intro/outro (full music + ducking):", cmd);

      await runFfmpegWithProgress(cmd, {
        jobId,
        step: "intro_outro",
        label: ducking ? "intro/outro(music+ducking)" : "intro/outro(music)",
        totalDurationSec: totalDur,
        progressBase,
        progressSpan,
        message: "Intro/Outro + musique en cours...",
      });

      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

async function addIntroOutroWithOptions(
  corePath,
  outputPath,
  introPath,
  outroPath,
  totalDuration,
  musicOpts,
  { jobId = null, progressBase = 60, progressSpan = 25 } = {}
) {
  const tmpDir = path.dirname(outputPath);
  const ioPath = path.join(tmpDir, `io_${Date.now()}_${sanitizeFilename(path.basename(outputPath))}`);

  if (!introPath || !outroPath) {
    fs.copyFileSync(corePath, outputPath);
    return;
  }

  const mode = musicOpts?.mode || "none";

  if (mode === "none") {
    await addIntroOutroNoMusic(introPath, corePath, outroPath, ioPath, { jobId, progressBase, progressSpan });
  } else if (mode === "full_music") {
    const musicPath = musicOpts?.musicPath;
    if (!musicPath) throw new Error("musicPath manquant (full_music)");
    await addIntroOutroFullMusic(introPath, corePath, outroPath, musicPath, ioPath, {
      jobId,
      progressBase,
      progressSpan,
      musicVolume: Number(musicOpts.musicVolume) || 0.6,
      ducking: true,
    });
  } else if (mode === "intro_outro_music") {
    // Keep existing behavior if you have a dedicated function
    await addIntroOutroIntroOutroMusic(introPath, corePath, outroPath, musicOpts, ioPath);
  } else {
    await addIntroOutroNoMusic(introPath, corePath, outroPath, ioPath, { jobId, progressBase, progressSpan });
  }

  fs.copyFileSync(ioPath, outputPath);
  safeUnlink(ioPath);
}

// ------------------------------------------------------
// ✅ Watermark
// ------------------------------------------------------
function applyWatermark(inputPath, outputPath, { jobId = null, progressBase = 85, progressSpan = 10 } = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const watermarkPath = path.join(process.cwd(), "assets", "watermark.png");

      if (!fs.existsSync(watermarkPath)) {
        console.warn("⚠️ Watermark introuvable, skip watermark:", watermarkPath);
        return resolve();
      }

      const dur = await getVideoDuration(inputPath).catch(() => null);

      const filter = `movie='${watermarkPath}':loop=0,scale=150:-1[wm];[0:v][wm]overlay=W-w-20:H-h-20:format=auto`;

      const cmd =
        `ffmpeg -y -i "${inputPath}" ` +
        `-vf "${filter}" ` +
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

      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

// ------------------------------------------------------
// ✅ Main
// ------------------------------------------------------
export default async function processVideo(eventId, selectedVideoIds, effectivePreset = null, opts = {}) {
  effectivePreset = normalizeEffectivePreset(effectivePreset);

  const jobId = opts?.jobId || null;
  const jobUpdate = (patch) => (jobId ? updateVideoJob(jobId, patch).catch(() => {}) : Promise.resolve());

  try {
    console.log("🚀 processVideo start", { eventId, selectedVideoIds, effectivePreset });

    await jobUpdate({ status: "processing", step: "init", progress: 0, message: "Montage lancé", error: null });

    const { data: ev, error: evErr } = await supabaseAdmin
      .from("events")
      .select("id, user_id, title, final_video_path")
      .eq("id", eventId)
      .single();

    if (evErr || !ev) throw new Error("Event introuvable");

    await supabaseAdmin.from("events").update({ status: "processing" }).eq("id", eventId);

    const { data: videos, error: vidsErr } = await supabaseAdmin
      .from("videos")
      .select("id, storage_path")
      .eq("event_id", eventId)
      .in("id", selectedVideoIds);

    if (vidsErr) throw vidsErr;

    const videosToProcess = (videos || []).filter(Boolean);

    if (videosToProcess.length === 0) throw new Error("Aucune vidéo sélectionnée");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `gp_${sanitizeFilename(eventId)}_`));
    safeMkdir(tmpDir);

    console.log("🗂️ tmpDir:", tmpDir);

    // Download + normalize with concurrency
    console.log("➡️ Étape 3 : Téléchargement + Normalisation");

    const processedPaths = new Array(videosToProcess.length).fill(null);

    for (let i = 0; i < videosToProcess.length; i += NORMALIZE_CONCURRENCY) {
      const batch = videosToProcess.slice(i, i + NORMALIZE_CONCURRENCY);

      const batchPromises = batch.map(async (v, j) => {
        const globalIndex = i + j;
        const localPath = path.join(tmpDir, `raw_${globalIndex}.mp4`);
        const normalizedPath = path.join(tmpDir, `norm_${globalIndex}.mp4`);

        console.log("⬇️ Download video:", { id: v.id, storage_path: v.storage_path });

        const { data: fileData, error: dlErr } = await supabaseAdmin.storage
          .from("videos")
          .download(v.storage_path);

        if (dlErr) throw dlErr;

        const buffer = Buffer.from(await fileData.arrayBuffer());
        fs.writeFileSync(localPath, buffer);

        const inSummary = await probeStreamsSummary(localPath, { label: `input_${globalIndex}` });
        logStreamsJson("🧾 STREAMS(input)", { index: globalIndex, inputPath: localPath, streams: inSummary });

        await normalizeVideo(localPath, normalizedPath, 30, {
          jobId: opts?.jobId || null,
          progressBase: Math.round((globalIndex / Math.max(1, videosToProcess.length)) * 35),
          progressSpan: Math.max(2, Math.round(35 / Math.max(1, videosToProcess.length))),
          label: `normalize_${globalIndex}`,
          globalIndex,
        });

        processedPaths[globalIndex] = normalizedPath;

        safeUnlink(localPath);
      });

      await Promise.all(batchPromises);
    }

    const orderedProcessedPaths = processedPaths.filter(Boolean);

    // durations
    const durations = [];
    for (const p of orderedProcessedPaths) durations.push(await getVideoDuration(p));

    const presetForConcat = safePreset(effectivePreset);

    const concatPath = path.join(tmpDir, "concat.mp4");
    await runFFmpegFilterConcat(
      orderedProcessedPaths,
      durations,
      concatPath,
      resolveTransitionName(presetForConcat),
      resolveTransitionDuration(presetForConcat),
      { jobId: opts?.jobId || null, progressBase: 35, progressSpan: 25 }
    );

    // Intro / Outro / Music
    const totalDuration = durations.reduce((a, b) => a + (Number(b) || 0), 0);
    const noWmPath = path.join(tmpDir, "no_wm.mp4");

    await addIntroOutroWithOptions(
      concatPath,
      noWmPath,
      presetForConcat?.intro?.path || null,
      presetForConcat?.outro?.path || null,
      totalDuration,
      presetForConcat?.music || null,
      { jobId: opts?.jobId || null, progressBase: 60, progressSpan: 25 }
    );

    // Watermark (if not premium)
    const outputPath = path.join(tmpDir, `final_${sanitizeFilename(eventId)}.mp4`);

    if (presetForConcat?.watermark?.enabled) {
      await applyWatermark(noWmPath, outputPath, { jobId: opts?.jobId || null, progressBase: 85, progressSpan: 10 });
    } else {
      fs.copyFileSync(noWmPath, outputPath);
    }

    // Upload final video
    const stat = await fs.promises.stat(outputPath);
    await jobUpdate({ status: "processing", step: "upload", progress: 95, message: "Upload vidéo finale...", error: null });
    console.log("⬆️ Upload final vidéo (local):", outputPath);

    const finalStoragePath = `final_videos/${sanitizeFilename(eventId)}/${Date.now()}_final.mp4`;

    const fileBuf = fs.readFileSync(outputPath);
    const { error: upErr } = await supabaseAdmin.storage
      .from("final_videos")
      .upload(finalStoragePath, fileBuf, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (upErr) throw upErr;

    await supabaseAdmin.from("events").update({ final_video_path: finalStoragePath, status: "done" }).eq("id", eventId);

    const { data: pub } = supabaseAdmin.storage.from("final_videos").getPublicUrl(finalStoragePath);
    const finalVideoUrl = pub?.publicUrl || null;

    await jobUpdate({ status: "done", step: "done", progress: 100, message: "Vidéo générée", error: null });

    return { ok: true, finalVideoUrl };
  } catch (e) {
    const errMsg = String(e?.message || e);
    console.error("❌ processVideo failed:", errMsg);
    await jobUpdate({ status: "failed", step: "failed", progress: 100, message: errMsg, error: errMsg });
    try {
      await supabaseAdmin.from("events").update({ status: "failed" }).eq("id", eventId);
    } catch {}
    throw e;
  }
}
