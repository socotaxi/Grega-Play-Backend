import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { createClient } from "@supabase/supabase-js";
import https from "https";
import http from "http";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fetch from "cross-fetch";
import { promisify } from "util";
import { TRANSITION_MAP, safePreset, resolveTransitionName, resolveTransitionDuration, normalizeEffectivePreset } from "./videoProcessing/videoPreset.schema.js";

global.fetch = fetch;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

// Hard safety: prevent FFmpeg from hanging forever in production
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 20 * 60 * 1000); // default 20 minutes
const EXEC_MAX_BUFFER = Number(process.env.EXEC_MAX_BUFFER || 50 * 1024 * 1024); // 50MB

async function runCmd(cmd, { label = "cmd" } = {}) {
  try {
    // Use execAsync with hard timeout + buffer limits (prevents FFmpeg hangs on Railway)
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (e) {
    // Normalize node's timeout error message
    if (e && (e.killed || String(e.message || "").includes("timed out"))) {
      e.message = `Timeout (${Math.round(FFMPEG_TIMEOUT_MS / 1000)}s) sur ${label}`;
    }
    throw e;
  }
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant.");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 🔐 Helper pour éviter l'erreur EBUSY sur Windows lors du rename
const renameAsync = promisify(fs.rename);

async function safeRenameWithRetry(src, dest, options = {}) {
  const { retries = 8, delayMs = 300 } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await renameAsync(src, dest);
      return;
    } catch (e) {
      const isLast = attempt === retries;
      const code = e?.code;

      if (!isLast && (code === "EBUSY" || code === "EPERM" || code === "EACCES")) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
}

// ------------------------------------------------------
// ------------------------------------------------------
// ✅ Preset helpers (centralised via videoPreset.schema.js)
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

  const candidates = [
    "premium_preset",
    "montage_preset",
    "video_preset",
    "preset",
    "final_preset",
    "premium_options",
    "render_preset",
    "processing_preset",
  ];

  for (const k of candidates) {
    const val = eventRow[k];
    if (val && typeof val === "object") return val;

    if (typeof val === "string" && val.trim()) {
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

// ✅ Télécharger un fichier via URL (https/http)
function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(outputPath);

    proto
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          return reject(new Error(`Téléchargement échoué: ${response.statusCode}`));
        }
        response.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        fs.unlink(outputPath, () => reject(err));
      });
  });
}

// ------------------------------------------------------
// ✅ ffprobe helpers
// ------------------------------------------------------
async function hasAudioStream(inputPath) {
  try {
    const cmd = `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "${inputPath}"`;
    const { stdout } = await runCmd(cmd, { label: "hasAudioStream(ffprobe)" });
    return String(stdout || "").trim() === "audio";
  } catch {
    return false;
  }
}

async function probeStreamsSummary(inputPath) {
  try {
    const cmd = `ffprobe -v error -show_entries stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,bit_rate,sample_rate,channels:stream_tags=rotate -of json "${inputPath}"`;
    const { stdout } = await runCmd(cmd, { label: "probeStreamsSummary(ffprobe)" });
    const json = JSON.parse(stdout || "{}");
    const streams = Array.isArray(json.streams) ? json.streams : [];
    return streams.map((s) => ({
      type: s.codec_type,
      codec: s.codec_name,
      w: s.width,
      h: s.height,
      r: s.r_frame_rate,
      avg: s.avg_frame_rate,
      sr: s.sample_rate,
      ch: s.channels,
      rotate: s?.tags?.rotate,
    }));
  } catch {
    return [{ error: "probe_failed" }];
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
// ✅ Normalisation robuste (portrait 720x1280 + 30fps + audio garanti)
// ------------------------------------------------------
async function normalizeVideo(inputPath, outputPath, fps = 30) {
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

  console.log("➡️ FFmpeg normalize (robuste):", cmd);

  const { stderr } = await runCmd(cmd, { label: "normalize(ffmpeg)" });
  if (stderr) console.log("ℹ️ FFmpeg normalize stderr (tail):", String(stderr).slice(-2000));
  console.log("✅ Vidéo normalisée:", outputPath);
}

// ------------------------------------------------------
// ✅ Concat xfade + acrossfade
// ------------------------------------------------------
function runFFmpegFilterConcat(processedPaths, durations, outputPath, transition = "fadeblack", transitionDuration = 0.3) {
  return new Promise((resolve, reject) => {
    const inputs = processedPaths.map((p) => `-i "${p}"`).join(" ");

    let offset = 0;
    const offsets = [];
    for (let i = 0; i < durations.length - 1; i++) {
      const d = Number(durations[i]) || 0;
      const step = Math.max(d - transitionDuration, 0);
      offset += step;
      offsets.push(Number(offset.toFixed(3)));
    }

    console.log("🧩 CONCAT DEBUG durations:", durations.map((d) => Number(d?.toFixed?.(3) ?? d)));
    console.log("🧩 CONCAT DEBUG transition:", transition, "dur:", transitionDuration, "offsets:", offsets);

    let filter = "";

    for (let i = 0; i < processedPaths.length; i++) {
      filter +=
        `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,` +
        `fps=30,format=yuv420p,` +
        `scale=720:1280:force_original_aspect_ratio=decrease,` +
        `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,` +
        `setsar=1[v${i}];`;

      filter +=
        `[${i}:a]asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `aresample=48000[a${i}];`;
    }

    let vLast = "v0";
    let aLast = "a0";

    for (let i = 1; i < processedPaths.length; i++) {
      const vOut = `v${i}o`;
      const aOut = `a${i}o`;
      const off = offsets[i - 1] ?? 0;

      filter += `[${vLast}][v${i}]xfade=transition=${transition}:duration=${transitionDuration}:offset=${off}[${vOut}];`;
      filter += `[${aLast}][a${i}]acrossfade=d=${transitionDuration}:c1=tri:c2=tri[${aOut}];`;

      vLast = vOut;
      aLast = aOut;
    }

    // ✅ FIX: éviter le filtre vide '' (ffmpeg "No such filter: ''") quand filter_complex finit par ';'
    filter = String(filter || "").trim();
    if (filter.endsWith(";")) filter = filter.slice(0, -1);

    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[${vLast}]" -map "[${aLast}]" ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
      `-c:a aac -b:a 128k "${outputPath}"`;

    console.log("➡️ FFmpeg concat+xfade:", cmd);

    exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg concat error (stderr tail):", String(stderr || stdout).slice(-4000));
        return reject(new Error(`Erreur FFmpeg (concat xfade): ${String(stderr || stdout).slice(-4000)}`));
      }
      console.log("✅ Concat terminé:", outputPath);
      resolve();
    });
  });
}

// ------------------------------------------------------
// ✅ Resolve visual assets (default | custom_image | custom_text)
// ------------------------------------------------------
async function getSignedPremiumAssetUrl(storagePath, expiresInSeconds = 1800) {
  const { data, error } = await supabase.storage.from("premium-assets").createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data?.signedUrl) throw error || new Error("Signed URL introuvable (premium-assets).");
  return data.signedUrl;
}

async function generateTextSlide(outputPngPath, text, durationSeconds) {
  const safeText = String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");

  const cmd = `ffmpeg -y -f lavfi -i "color=c=black:s=720x1280:d=${Number(durationSeconds) || 3}" -vframes 1 -vf "drawtext=text='${safeText}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=12" "${outputPngPath}"`;
  console.log("➡️ FFmpeg text slide:", cmd);
  await runCmd(cmd, { label: "generateTextSlide(ffmpeg)" });
}

async function resolveVisualAsset({ kind, preset, defaultPath, tempDir }) {
  const p = preset && typeof preset === "object" ? preset : {};
  const type = typeof p.type === "string" ? p.type : "default";

  if (type === "custom_image" && p.storagePath) {
    try {
      const local = path.join(tempDir, `${kind}_custom${path.extname(p.storagePath) || ".png"}`);
      const signedUrl = await getSignedPremiumAssetUrl(p.storagePath, 60 * 30);
      await downloadFile(signedUrl, local);
      return local;
    } catch (e) {
      console.warn(`⚠️ Impossible de charger ${kind} custom_image, fallback default.`, e);
      return defaultPath;
    }
  }

  if (type === "custom_text" && p.text) {
    try {
      const duration = kind === "intro" ? 3 : 2;
      const local = path.join(tempDir, `${kind}_text.png`);
      await generateTextSlide(local, p.text, duration);
      return local;
    } catch (e) {
      console.warn(`⚠️ Impossible de générer ${kind} custom_text, fallback default.`, e);
      return defaultPath;
    }
  }

  return defaultPath;
}

// ------------------------------------------------------
// ✅ Musique + ducking
// ------------------------------------------------------
function duckMusicAgainstVoice() {
  return `sidechaincompress=threshold=0.02:ratio=10:attack=20:release=250:makeup=1`;
}

function addIntroOutroWithOptions(corePath, outputPath, introPath, outroPath, totalDuration, musicPreset) {
  const p = musicPreset && typeof musicPreset === "object" ? musicPreset : {};
  const mode = typeof p.mode === "string" ? p.mode : "none";
  const volume = Math.max(0.05, Math.min(1, Number(p.volume) || 0.6));
  const ducking = Boolean(p.ducking);

  const signaturePath = path.join(__dirname, "assets", "signature.mp3");

  return new Promise(async (resolve, reject) => {
    try {
      let musicPath = null;

      if (mode !== "none") {
        if (p.storagePath) {
          const local = path.join(path.dirname(outputPath), `music_custom${path.extname(p.storagePath) || ".mp3"}`);
          const signedUrl = await getSignedPremiumAssetUrl(p.storagePath, 60 * 30);
          await downloadFile(signedUrl, local);
          musicPath = local;
        } else if (fs.existsSync(signaturePath)) {
          musicPath = signaturePath;
        }
      }

      if (mode === "none" || !musicPath) {
        return addIntroOutroNoMusic(corePath, outputPath, introPath, outroPath).then(resolve).catch(reject);
      }

      if (mode === "intro_outro") {
        return addIntroOutroIntroOutroMusic(corePath, outputPath, introPath, outroPath, totalDuration, musicPath, volume, ducking)
          .then(resolve)
          .catch(reject);
      }

      if (mode === "full") {
        return addIntroOutroFullMusic(corePath, outputPath, introPath, outroPath, totalDuration, musicPath, volume, ducking)
          .then(resolve)
          .catch(reject);
      }

      return addIntroOutroNoMusic(corePath, outputPath, introPath, outroPath).then(resolve).catch(reject);
    } catch (e) {
      return reject(e);
    }
  });
}

function addIntroOutroNoMusic(corePath, outputPath, introPath, outroPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(introPath) || !fs.existsSync(outroPath)) {
      console.warn("⚠️ intro/outro introuvable, export sans habillage.");
      fs.copyFileSync(corePath, outputPath);
      return resolve();
    }

    const introDur = 3;
    const outroDur = 2;

    // Important: pad() pour forcer toutes les images/vidéos à 720x1280 avant concat
    const filter = [
      `[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v0]`,
      `[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v1]`,
      `[2:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v2]`,
      `[v0][v1][v2]concat=n=3:v=1:a=0[v]`,
      // on décale l'audio du core pour commencer après l'intro
      `[1:a]adelay=${introDur * 1000}|${introDur * 1000},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[a]`,
    ].join("; ");

    const cmdNoMusic =
      `ffmpeg -y -loop 1 -t ${introDur} -i "${introPath}" -i "${corePath}" -loop 1 -t ${outroDur} -i "${outroPath}" ` +
      `-filter_complex "${filter}" -map "[v]" -map "[a]" ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k "${outputPath}"`;

    console.log("➡️ FFmpeg intro/outro (no music):", cmdNoMusic);

    exec(cmdNoMusic, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg intro/outro (no music) error:", stderr || stdout);
        return reject(new Error(`Erreur FFmpeg (intro/outro sans musique): ${String(stderr || stdout).slice(-2000)}`));
      }
      console.log("✅ Intro/outro ajoutés (sans musique):", outputPath);
      resolve();
    });
  });
}

// NOTE: tes fonctions addIntroOutroIntroOutroMusic / addIntroOutroFullMusic doivent déjà exister plus bas dans ton fichier.
// Ici je laisse le reste inchangé, comme dans ton original.

function addIntroOutroFullMusic(corePath, outputPath, introPath, outroPath, totalDuration, musicPath, volume, ducking) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(introPath) || !fs.existsSync(outroPath)) {
      console.warn("⚠️ intro/outro introuvable, export sans habillage.");
      fs.copyFileSync(corePath, outputPath);
      return resolve();
    }

    const safeTotal = Math.max(0, Number(totalDuration) || 0);
    const introDur = 3;
    const outroDur = 2;
    const coreDur = Math.max(safeTotal - introDur - outroDur, 0);
    const totalWithIO = introDur + coreDur + outroDur;

    // Ducking optionnel (musique baissée quand la voix est présente)
    const duckFilter = ducking ? `[music][voice]${duckMusicAgainstVoice()}[musicduck]` : ``;
    const musicLabel = ducking ? "musicduck" : "music";

    const filterParts = [
      // Pads pour éviter l'erreur concat (différences de tailles)
      `[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v0]`,
      `[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v1]`,
      `[2:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v2]`,
      `[v0][v1][v2]concat=n=3:v=1:a=0[v]`,

      // Voix = audio du core décalé pour commencer après l'intro
      `[1:a]adelay=${introDur * 1000}|${introDur * 1000},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[voice]`,

      // Musique = loop + trim à la durée totale du montage
      `[3:a]volume=${Number(volume) || 0.6},atrim=0:${totalWithIO},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000[music]`,
    ];

    if (ducking) filterParts.push(duckFilter);

    // Mix final
    filterParts.push(`[voice][${musicLabel}]amix=inputs=2:duration=longest[a]`);

    const filter = filterParts.join("; ");

    const cmd =
      `ffmpeg -y ` +
      `-loop 1 -t ${introDur} -i "${introPath}" ` +
      `-i "${corePath}" ` +
      `-loop 1 -t ${outroDur} -i "${outroPath}" ` +
      `-stream_loop -1 -i "${musicPath}" ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k "${outputPath}"`;

    console.log("➡️ FFmpeg intro/outro (full music + ducking):", cmd);

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg intro/outro (full) error:", stderr || stdout);
        return reject(new Error(`Erreur FFmpeg (musique full): ${String(stderr || stdout).slice(-2000)}`));
      }
      console.log("✅ Intro/outro + musique full:", outputPath);
      resolve();
    });
  });
}

// ✅ Watermark
function applyWatermark(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const watermarkPath = path.join(__dirname, "assets", "watermark.png");

    if (!fs.existsSync(watermarkPath)) {
      console.warn("⚠️ watermark.png introuvable, on skip watermark.");
      fs.copyFileSync(inputPath, outputPath);
      return resolve();
    }

    const cmd = `ffmpeg -y -i "${inputPath}" -i "${watermarkPath}" -filter_complex "overlay=W-w-20:H-h-20" -c:v libx264 -preset veryfast -crf 23 -c:a copy "${outputPath}"`;
    console.log("➡️ FFmpeg watermark:", cmd);

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg watermark error:", stderr || stdout);
        return reject(new Error(`Erreur FFmpeg (watermark): ${String(stderr || stdout).slice(-2000)}`));
      }
      console.log("✅ Watermark appliqué:", outputPath);
      resolve();
    });
  });
}

export default async function processVideo(eventId, selectedVideoIds, effectivePreset = null) {
  // 🔒 Ensure preset shape is consistent everywhere (controller & processVideo)
  effectivePreset = normalizeEffectivePreset(effectivePreset);

  console.log(`🎬 Démarrage du montage pour l'événement : ${eventId}`);

  // 🔄 status = processing
  {
    const { error: processingError } = await supabase.from("events").update({ status: "processing" }).eq("id", eventId);
    if (processingError) {
      console.error("❌ Impossible de passer l'événement en processing:", processingError);
      throw new Error("Impossible de lancer le montage (status processing).");
    }
  }

  // ✅ Charger event
  let eventRow = null;
  try {
    const { data: ev, error: evErr } = await supabase.from("events").select("*").eq("id", eventId).single();
    if (!evErr) eventRow = ev;
    else console.warn("⚠️ events select error:", evErr);
  } catch (e) {
    console.warn("⚠️ Exception chargement événement:", e);
  }

  const isPremiumEvent = inferIsPremiumEvent(eventRow);

  // ✅ IMPORTANT: preset DB > preset param > null (sans condition premium)
  const presetFromDb = pickPresetFromEventRow(eventRow);
  const effectivePresetResolved = presetFromDb || effectivePreset || null;

  // ✅ LOGS PREUVE (doivent apparaître à chaque montage)
  const presetProof = safePreset(effectivePresetResolved);
  console.log("🎛️ PRESET RESOLVED (PROOF)", {
    isPremiumEvent,
    hasPresetFromDb: Boolean(presetFromDb),
    hasPresetFromParam: Boolean(effectivePreset),
    transition: presetProof.transition,
    transitionDuration: presetProof.transitionDuration,
    intro: presetProof.intro,
    outro: presetProof.outro,
    music: presetProof.music,
  });

  if (eventRow) {
    console.log("🧾 EVENT PRESET CANDIDATES (debug):", {
      premium_preset: eventRow.premium_preset,
      montage_preset: eventRow.montage_preset,
      video_preset: eventRow.video_preset,
      preset: eventRow.preset,
      final_preset: eventRow.final_preset,
      premium_options: eventRow.premium_options,
      render_preset: eventRow.render_preset,
      processing_preset: eventRow.processing_preset,
    });
  }

  if (!Array.isArray(selectedVideoIds) || selectedVideoIds.length < 2) {
    throw new Error("Au moins 2 vidéos doivent être sélectionnées pour le montage.");
  }

  // 1) vidéos
  console.log("➡️ Étape 1 : Récupération des vidéos sélectionnées depuis Supabase...");
  const { data: videos, error } = await supabase
    .from("videos")
    .select("id, storage_path")
    .eq("event_id", eventId)
    .in("id", selectedVideoIds);

  if (error) {
    console.error("❌ Erreur récupération vidéos:", error);
    throw new Error("Erreur récupération vidéos sélectionnées.");
  }

  const videosToProcess = (videos || []).filter((v) => v.storage_path);
  if (videosToProcess.length < 2) {
    throw new Error("Pas assez de vidéos valides pour lancer le montage.");
  }

  // 2) tmp
  const tempRoot = path.join(__dirname, "tmp");
  if (!fs.existsSync(tempRoot)) fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = path.join(tempRoot, eventId);
  fs.mkdirSync(tempDir, { recursive: true });

  // 3) download + normalize
  console.log("➡️ Étape 3 : Téléchargement + Normalisation (portrait)...");
  const processedPaths = [];
  const CONCURRENCY = 2;

  for (let i = 0; i < videosToProcess.length; i += CONCURRENCY) {
    const slice = videosToProcess.slice(i, i + CONCURRENCY);

    const batchPromises = slice.map((video, idx) => {
      const globalIndex = i + idx;
      const { publicUrl } = supabase.storage.from("videos").getPublicUrl(video.storage_path).data;

      const localPath = path.join(tempDir, `video${globalIndex}_raw.mp4`);
      const normalizedPath = path.join(tempDir, `video${globalIndex}.mp4`);

      return (async () => {
        console.log(`⬇️ Téléchargement (batch) : ${publicUrl}`);
        await downloadFile(publicUrl, localPath);

        const inSummary = await probeStreamsSummary(localPath);
        console.log(`🧾 INPUT STREAMS video${globalIndex}:`, inSummary);

        await normalizeVideo(localPath, normalizedPath, 30);

        const outSummary = await probeStreamsSummary(normalizedPath);
        console.log(`🧾 OUTPUT STREAMS video${globalIndex}:`, outSummary);

        processedPaths.push(normalizedPath);
      })();
    });

    await Promise.all(batchPromises);
  }

  // 3.1 durations
  console.log("➡️ Étape 3.1 : Récupération des durées (ffprobe)...");
  const durations = [];
  for (const p of processedPaths) durations.push(await getVideoDuration(p));

  const outputPath = path.join(tempDir, "final.mp4");

  // 4) concat with preset transition
  const presetForConcat = safePreset(effectivePresetResolved);
  await runFFmpegFilterConcat(
    processedPaths,
    durations,
    outputPath,
    resolveTransitionName(presetForConcat),
    resolveTransitionDuration(presetForConcat)
  );

  // 4.1) intro/outro + music
  const corePath = path.join(tempDir, "final_core.mp4");
  await safeRenameWithRetry(outputPath, corePath, { retries: 8, delayMs: 300 });

  let coreDuration = 0;
  try {
    coreDuration = await getVideoDuration(corePath);
  } catch (e) {
    console.warn("⚠️ Impossible de récupérer la durée de la vidéo core:", e);
  }

  const preset = safePreset(effectivePresetResolved);
  const defaultIntroPath = path.join(__dirname, "assets", "intro.png");
  const defaultOutroPath = path.join(__dirname, "assets", "outro.png");

  const introPath = await resolveVisualAsset({ kind: "intro", preset: preset.intro, defaultPath: defaultIntroPath, tempDir });
  const outroPath = await resolveVisualAsset({ kind: "outro", preset: preset.outro, defaultPath: defaultOutroPath, tempDir });

  const totalDuration = 3 + coreDuration + 2;
  const noWmPath = path.join(tempDir, "final_no_wm.mp4");

  try {
    await addIntroOutroWithOptions(corePath, noWmPath, introPath, outroPath, totalDuration, preset.music);
  } catch (e) {
    console.error("⚠️ Erreur add intro/outro:", e);
    fs.copyFileSync(corePath, noWmPath);
  }

  // 4.2 watermark
  try {
    await applyWatermark(noWmPath, outputPath);
  } catch (e) {
    console.error("⚠️ Erreur watermark, on garde la vidéo sans filigrane.", e);
    if (!fs.existsSync(outputPath) && fs.existsSync(noWmPath)) fs.copyFileSync(noWmPath, outputPath);
  }

  // 5) upload
  if (!fs.existsSync(outputPath)) throw new Error("Vidéo finale introuvable sur disque (final.mp4).");

  const stat = await fs.promises.stat(outputPath);
  console.log("⬆️ Upload final vidéo (local):", outputPath);
  console.log("⬆️ Upload final vidéo (size):", stat.size);

  const FINAL_BUCKET = "videos";
  const finalStoragePath = `final_videos/events/${eventId}/final_${Date.now()}.mp4`;

  const buffer = await fs.promises.readFile(outputPath);

  console.log(`⬆️ Upload final vidéo (bucket=${FINAL_BUCKET}, path):`, finalStoragePath);

  const { data: upData, error: uploadError } = await supabase.storage.from(FINAL_BUCKET).upload(finalStoragePath, buffer, {
    contentType: "video/mp4",
    upsert: true,
    cacheControl: "3600",
  });

  if (uploadError) {
    console.error("❌ Erreur upload final (supabase):", uploadError);
    throw new Error(`Erreur upload de la vidéo finale: ${uploadError.message || "unknown"}`);
  }

  console.log("✅ Upload final OK:", upData?.path || finalStoragePath);

  const { data: publicFinal } = supabase.storage.from(FINAL_BUCKET).getPublicUrl(finalStoragePath);
  let finalVideoUrl = publicFinal?.publicUrl || null;

  if (!finalVideoUrl) {
    const { data: signed, error: signedErr } = await supabase.storage.from(FINAL_BUCKET).createSignedUrl(finalStoragePath, 60 * 60);
    if (signedErr) console.warn("⚠️ Signed URL error (videos):", signedErr);
    else finalVideoUrl = signed?.signedUrl || null;
  }

  const { error: updateError } = await supabase
    .from("events")
    .update({
      status: "done",
      final_video_url: finalVideoUrl,
      final_video_path: finalStoragePath,
    })
    .eq("id", eventId);

  if (updateError) {
    console.error("❌ Erreur update event:", updateError);
    throw new Error("Erreur mise à jour event (final_video_url).");
  }

  console.log("✅ Montage terminé:", finalVideoUrl);

  return { ok: true, finalVideoUrl };
}
