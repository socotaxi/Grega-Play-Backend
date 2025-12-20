// controllers/videos.controller.js (ESM)
import fs from "fs";
import path from "path";
import util from "util";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";
import fetch from "cross-fetch";
import { createClient } from "@supabase/supabase-js";

import processVideo, { getVideoJobStatus } from "../services/processVideo.js";
import { computeEventCapabilities } from "../services/capabilitiesService.js";
import { createVideoJob, updateVideoJob, getVideoJob } from "../services/db/videoJobs.repo.js";
import { resolveEffectivePreset } from "../services/presetResolver.js";

global.fetch = fetch;

const JOB_DEADLINE_MS = Number(process.env.JOB_DEADLINE_MS) || 12 * 60 * 1000;

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || process.env.API_KEY || "";

function isAdmin(req) {
  const key = (req.headers["x-admin-key"] || "").toString();
  return !!ADMIN_API_KEY && key === ADMIN_API_KEY;
}

async function failJobTimeoutIfNeeded(job) {
  if (!job) return job;
  if (job.status !== "processing") return job;
  if (!job.started_at) return job;

  const startedAt = new Date(job.started_at).getTime();
  if (!Number.isFinite(startedAt)) return job;

  const now = Date.now();
  if (now - startedAt <= JOB_DEADLINE_MS) return job;

  try {
    await updateVideoJob(job.id, {
      status: "failed",
      progress: 0,
      error: `TIMEOUT: job processing > ${Math.round(JOB_DEADLINE_MS / 1000)}s`,
      finished_at: new Date().toISOString(),
    });
    return {
      ...job,
      status: "failed",
      progress: 0,
      error: `TIMEOUT: job processing > ${Math.round(JOB_DEADLINE_MS / 1000)}s`,
      finished_at: new Date().toISOString(),
    };
  } catch (e) {
    console.error("❌ Impossible de marquer le job en timeout:", e?.message || e);
    return job;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = util.promisify(exec);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant (env).");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ------------------------------------------------------
// ✅ Constantes upload
// ------------------------------------------------------
const ALLOWED_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
];

const MAX_FILE_SIZE_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

const tmp = path.join(__dirname, "..", "tmp");
if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------
function sanitizeFileName(name = "video") {
  const base = String(name)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .trim();
  return base.length ? base : `video_${Date.now()}`;
}

function downloadFile(url, outputPath) {
  const client = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);

    const req = client.get(url, { rejectUnauthorized: false }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Échec téléchargement ${url}: ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });

    req.on("error", reject);
    req.end();
  });
}

async function getVideoDuration(filePath) {
  try {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${filePath}"`;
    const { stdout } = await execAsync(cmd);
    const d = Number(String(stdout).trim());
    return Number.isFinite(d) ? d : null;
  } catch (e) {
    console.warn("⚠️ Impossible de lire la durée vidéo (ffprobe).", e?.message);
    return null;
  }
}

async function compressVideo(inputPath, outputPath) {
  const cmd = `ffmpeg -y -i "${inputPath}" -vf "scale=720:-2" -c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`;
  await execAsync(cmd);
}

async function uploadToSupabase(bucket, filePath, storagePath, contentType) {
  const fileBuffer = await fs.promises.readFile(filePath);

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, fileBuffer, {
      contentType,
      upsert: true,
    });

  if (uploadError) {
    console.error("❌ Erreur upload Supabase Storage:", uploadError);
    throw new Error("Erreur upload Supabase Storage");
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);

  if (!data?.publicUrl) {
    throw new Error("Impossible de récupérer l’URL publique Supabase");
  }

  return data.publicUrl;
}

async function logRejectedUpload({ req, reason, file, eventId, participantName, duration }) {
  try {
    console.warn("🚫 Upload rejeté:", {
      reason,
      eventId,
      participantName,
      mimetype: file?.mimetype,
      size: file?.size,
      duration,
      ip: req?.ip,
      ua: req?.headers?.["user-agent"],
    });
  } catch {
    // no-op
  }
}

function getBucketAndPathFromPublicUrl(publicUrl) {
  if (!publicUrl || typeof publicUrl !== "string") return null;

  try {
    const url = new URL(publicUrl);
    const marker = "/object/public/";
    const idx = url.pathname.indexOf(marker);
    if (idx === -1) return null;

    const after = url.pathname.substring(idx + marker.length);
    const parts = after.split("/");
    if (parts.length < 2) return null;

    const bucket = parts[0];
    const pathInBucket = parts.slice(1).join("/");

    return { bucket, path: pathInBucket };
  } catch (e) {
    console.warn("⚠️ Impossible de parser l'URL publique Supabase:", publicUrl, e);
    return null;
  }
}

// stubs
async function notifyNewFinalVideo() {
  return;
}

// ------------------------------------------------------
// ✅ CONTROLLERS
// ------------------------------------------------------

export async function uploadVideo(req, res) {
  console.log("🟥 HIT /api/videos/upload", {
    hasFile: !!req.file,
    bodyKeys: Object.keys(req.body || {}),
  });

  const { eventId, userId, participantName, participantEmail } = req.body;
  const file = req.file;

  if (!eventId) {
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "eventId manquant." });
  }

  if (!userId) {
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "userId manquant." });
  }

  if (!file) {
    return res.status(400).json({ error: "Aucun fichier vidéo reçu." });
  }

  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    await logRejectedUpload({ req, reason: "MIME type non autorisé", file, eventId, participantName });

    if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);

    return res.status(400).json({
      error: "Format de fichier non autorisé. Seules les vidéos MP4 et MOV sont acceptées.",
    });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    await logRejectedUpload({
      req,
      reason: `Taille de fichier trop grande (>${MAX_FILE_SIZE_MB}MB)`,
      file,
      eventId,
      participantName,
    });

    if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);

    return res.status(400).json({
      error: `Fichier trop volumineux. La taille maximale autorisée est de ${MAX_FILE_SIZE_MB}MB.`,
    });
  }

  try {
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, title, deadline, user_id, status, max_videos, is_premium_event, premium_event_expires_at")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      await logRejectedUpload({ req, reason: "Événement introuvable", file, eventId, participantName });

      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(404).json({ error: "Événement introuvable." });
    }

    if (event.status !== "open") {
      await logRejectedUpload({ req, reason: "Événement non open", file, eventId, participantName });

      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);

      return res.status(400).json({
        error: "Cet événement est clôturé et n'accepte plus de vidéos.",
      });
    }

    const caps = await computeEventCapabilities({ userId, eventId });

    if (!caps?.role?.isCreator && !caps?.role?.isInvited) {
      await logRejectedUpload({ req, reason: "Participant non autorisé (capabilities)", file, eventId, participantName });

      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);

      return res.status(403).json({
        error: {
          code: "EVENT_FORBIDDEN",
          message: "Vous n'êtes pas autorisé à envoyer une vidéo pour cet événement.",
          status: 403,
        },
      });
    }

    if (!caps.actions?.canUploadVideo) {
      await logRejectedUpload({ req, reason: "UPLOAD_FORBIDDEN (capabilities)", file, eventId, participantName });

      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);

      return res.status(403).json({
        error: {
          code: "UPLOAD_FORBIDDEN",
          message: "Cet événement n'accepte plus de vidéos.",
          status: 403,
        },
      });
    }

    if (caps.state?.hasReachedUploadLimit) {
      await logRejectedUpload({ req, reason: "UPLOAD_LIMIT_REACHED (capabilities)", file, eventId, participantName });

      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);

      return res.status(403).json({
        error: {
          code: "UPLOAD_LIMIT_REACHED",
          message: "Limite atteinte. Version gratuite : une seule vidéo par événement.",
          status: 403,
        },
      });
    }

    const isCreator = !!caps?.role?.isCreator || userId === event.user_id;
    let participant = null;

    if (!isCreator) {
      const { data: existing, error: existingErr } = await supabase
        .from("event_participants")
        .select("id, has_submitted, user_id")
        .eq("event_id", eventId)
        .eq("user_id", userId)
        .maybeSingle();

      if (existingErr) console.warn("⚠️ event_participants lookup failed:", existingErr);

      if (existing) {
        participant = existing;
      } else {
        const { data: inserted, error: insErr } = await supabase
          .from("event_participants")
          .insert({
            event_id: eventId,
            user_id: userId,
            name: participantName || null,
            email: participantEmail || null,
            has_submitted: false,
          })
          .select("id, has_submitted, user_id")
          .single();

        if (insErr) {
          console.warn("⚠️ event_participants insert failed:", insErr);
        } else {
          participant = inserted;
        }
      }
    }

    const duration = await getVideoDuration(file.path);

    if (duration && duration > 30) {
      await logRejectedUpload({ req, reason: "Durée vidéo > 30 secondes", file, eventId, participantName, duration });

      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);

      return res.status(400).json({
        error: "La vidéo dépasse la durée maximale autorisée (30 secondes). Merci d'envoyer une vidéo plus courte.",
      });
    }

    const compressedDir = path.join(tmp, "compressed");
    if (!fs.existsSync(compressedDir)) fs.mkdirSync(compressedDir, { recursive: true });

    const safeFileName = sanitizeFileName(file.originalname);
    const baseNoExt = safeFileName.replace(/\.[^.]+$/, "");
    const compressedName = `${baseNoExt}.mp4`;
    const compressedFilePath = path.join(compressedDir, compressedName);

    await compressVideo(file.path, compressedFilePath);
    await fs.promises.unlink(file.path);

    const folder = `submissions/${eventId}/${userId}`;
    const storagePath = `${folder}/${Date.now()}-${compressedName}`;

    const publicUrl = await uploadToSupabase("videos", compressedFilePath, storagePath, "video/mp4");
    await fs.promises.unlink(compressedFilePath);

    const { data: insertedVideo, error: insertError } = await supabase
      .from("videos")
      .insert([
        {
          event_id: eventId,
          user_id: userId,
          participant_name: participantName || "Participant",
          participant_email: participantEmail || null,
          storage_path: storagePath,
          video_url: publicUrl,
          status: "uploaded",
          duration: duration ?? null,
        },
      ])
      .select()
      .single();

    if (insertError) {
      console.error("❌ Erreur insert videos:", insertError);
      return res.status(500).json({
        error: "Erreur lors de l'enregistrement de la vidéo. Merci de réessayer.",
      });
    }

    if (!isCreator && participant?.id) {
      await supabase
        .from("event_participants")
        .update({
          has_submitted: true,
          submitted_at: new Date().toISOString(),
        })
        .eq("id", participant.id);
    }

    return res.status(200).json({
      message: "Vidéo téléchargée et compressée avec succès.",
      video: insertedVideo,
      publicUrl,
    });
  } catch (err) {
    console.error("❌ Erreur lors de /api/videos/upload:", err);

    if (file?.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch { /* no-op */ }
    }

    return res.status(500).json({
      error: "Une erreur interne est survenue lors du traitement de la vidéo.",
    });
  }
}

export async function deleteVideo(req, res) {
  const { id } = req.params;

  try {
    const { data: video, error: videoError } = await supabase
      .from("videos")
      .select("id, video_url, event_id")
      .eq("id", id)
      .single();

    if (videoError || !video) {
      return res.status(404).json({ error: "Vidéo introuvable." });
    }

    const parsed = getBucketAndPathFromPublicUrl(video.video_url);

    if (parsed) {
      const { bucket, path: storagePath } = parsed;

      const { error: storageError } = await supabase.storage.from(bucket).remove([storagePath]);
      if (storageError) {
        console.error("❌ Erreur suppression fichier storage:", storageError);
      }
    } else {
      console.warn("⚠️ Impossible de déterminer bucket/path depuis l'URL publique.");
    }

    const { error: deleteError } = await supabase.from("videos").delete().eq("id", id);
    if (deleteError) {
      console.error("❌ Erreur suppression vidéo DB:", deleteError);
      return res.status(500).json({
        error: "Erreur lors de la suppression de la vidéo. Merci de réessayer.",
      });
    }

    return res.status(200).json({ message: "Vidéo supprimée avec succès." });
  } catch (err) {
    console.error("❌ Erreur DELETE /api/videos/:id:", err);
    return res.status(500).json({ error: "Erreur interne lors de la suppression de la vidéo." });
  }
}

export async function processVideoSync(req, res) {
  const { eventId, selectedVideoIds, userId, options } = req.body || {};

  if (!eventId) return res.status(400).json({ error: "eventId est requis." });
  if (!userId) return res.status(400).json({ error: "userId est requis." });

  try {
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, title, theme, status, user_id")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      console.error("❌ Erreur event introuvable:", eventError);
      return res.status(404).json({ error: "Événement introuvable." });
    }

    const caps = await computeEventCapabilities({ userId, eventId });

    if (!caps?.role?.isCreator) {
      return res.status(403).json({
        error: {
          code: "NOT_EVENT_CREATOR",
          message: "Seul le créateur de l'événement peut générer la vidéo finale.",
          status: 403,
        },
      });
    }

    let videoIds = [];

    if (Array.isArray(selectedVideoIds) && selectedVideoIds.length >= 2) {
      videoIds = selectedVideoIds;
    } else {
      const { data: videos, error: videosError } = await supabase
        .from("videos")
        .select("id")
        .eq("event_id", eventId);

      if (videosError) {
        console.error("❌ Erreur récupération vidéos:", videosError);
        return res.status(500).json({
          error: "Erreur lors de la récupération des vidéos de l'événement.",
        });
      }

      videoIds = (videos || []).map((v) => v.id);
    }

    if (!videoIds || videoIds.length < 2) {
      return res.status(400).json({
        error: "Au moins 2 vidéos sont nécessaires pour générer la vidéo finale.",
      });
    }

    const maxAllowed = caps?.limits?.maxClipsSelectableForFinal ?? 5;
    if (videoIds.length > maxAllowed) {
      return res.status(403).json({
        error: {
          code: "MAX_CLIPS_LIMIT",
          message: `Limite atteinte : ${maxAllowed} vidéo(s) maximum pour cet événement.`,
          status: 403,
        },
      });
    }

    // ✅ Preset effectif (sans dépendances manquantes)
    const effectivePreset = resolveEffectivePreset({
      capabilities: caps,
      requestedOptions: options || {},
      userId,
      eventId,
    });

    // ✅ Crée un job même en "sync" (évite job undefined et garde comportement stable)
    const job = await createVideoJob({
      eventId,
      userId,
      requestedOptions: options || {},
      effectivePreset,
    });

    await updateVideoJob(job.id, {
      status: "processing",
      progress: 5,
      started_at: new Date().toISOString(),
      error: null,
    });

    console.log("📼 Lancement génération vidéo finale (sync):", { eventId, clips: videoIds.length, jobId: job.id });

    const result = await processVideo(eventId, videoIds, effectivePreset, {
      jobId: job.id,
      deadlineMs: JOB_DEADLINE_MS,
      startedAtMs: Date.now(),
    });

    const finalVideoUrl = result?.finalVideoUrl || null;

    if (!finalVideoUrl) {
      console.error("❌ processVideo n'a pas retourné d'URL valide.");
      await updateVideoJob(job.id, {
        status: "failed",
        progress: 0,
        error: "Aucune URL finale retournée.",
        finished_at: new Date().toISOString(),
      });
      return res.status(500).json({
        error: "La génération de la vidéo finale a échoué (aucune URL retournée).",
      });
    }

    try {
      await notifyNewFinalVideo(event, finalVideoUrl);
    } catch (notifyErr) {
      console.error("⚠️ Vidéo générée mais notifications en erreur:", notifyErr);
    }

    await updateVideoJob(job.id, {
      status: "done",
      progress: 100,
      final_video_url: finalVideoUrl,
      finished_at: new Date().toISOString(),
      error: null,
    });

    return res.status(200).json({
      message: "Vidéo finale générée avec succès.",
      finalVideoUrl,
      jobId: job.id,
    });
  } catch (err) {
    console.error("❌ Erreur POST /api/videos/process:", err);
    return res.status(500).json({
      error: "Erreur interne lors du traitement de la vidéo finale (voir logs backend).",
    });
  }
}

export async function processVideoAsync(req, res) {
  const { eventId, selectedVideoIds, userId, options } = req.body || {};

  if (!eventId) return res.status(400).json({ error: "eventId est requis." });
  if (!userId) return res.status(400).json({ error: "userId est requis." });

  try {
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, user_id, title, status")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ error: "Événement introuvable." });
    }

    const caps = await computeEventCapabilities({ userId, eventId });

    if (!caps?.role?.isCreator) {
      return res.status(403).json({
        error: {
          code: "NOT_EVENT_CREATOR",
          message: "Seul le créateur de l'événement peut lancer un montage.",
          status: 403,
        },
      });
    }

    let videoIds = [];
    if (Array.isArray(selectedVideoIds) && selectedVideoIds.length >= 2) {
      videoIds = selectedVideoIds;
    } else {
      const { data: videos, error: videosError } = await supabase
        .from("videos")
        .select("id")
        .eq("event_id", eventId);

      if (videosError) {
        return res.status(500).json({
          error: "Erreur lors de la récupération des vidéos de l'événement.",
        });
      }
      videoIds = (videos || []).map((v) => v.id);
    }

    if (!videoIds || videoIds.length < 2) {
      return res.status(400).json({
        error: "Au moins 2 vidéos sont nécessaires pour générer la vidéo finale.",
      });
    }

    const maxAllowed = caps?.limits?.maxClipsSelectableForFinal ?? 5;
    if (videoIds.length > maxAllowed) {
      return res.status(403).json({
        error: {
          code: "MAX_CLIPS_LIMIT",
          message: `Limite atteinte : ${maxAllowed} vidéo(s) maximum pour cet événement.`,
          status: 403,
        },
      });
    }

    const effectivePreset = resolveEffectivePreset({
      capabilities: caps,
      requestedOptions: options || {},
      userId,
      eventId,
    });

    const job = await createVideoJob({
      eventId,
      userId,
      requestedOptions: options || {},
      effectivePreset,
    });

    setImmediate(async () => {
      try {
        await updateVideoJob(job.id, {
          status: "processing",
          progress: 5,
          started_at: new Date().toISOString(),
          error: null,
        });

        const result = await processVideo(eventId, videoIds, effectivePreset, {
          jobId: job.id,
          deadlineMs: JOB_DEADLINE_MS,
          startedAtMs: Date.now(),
        });

        const finalVideoUrl = result?.finalVideoUrl || null;

        await updateVideoJob(job.id, {
          status: "done",
          progress: 100,
          final_video_url: finalVideoUrl,
          finished_at: new Date().toISOString(),
          error: null,
        });
      } catch (e) {
        console.error("❌ Job montage failed:", e);
        try {
          await updateVideoJob(job.id, {
            status: "failed",
            progress: 0,
            error: e?.message || "Erreur inconnue pendant le montage.",
            finished_at: new Date().toISOString(),
          });
        } catch (inner) {
          console.error("❌ Impossible de mettre à jour le job en failed:", inner);
        }
      }
    });

    return res.status(202).json({
      message: "Montage lancé.",
      jobId: job.id,
      status: job.status,
    });
  } catch (e) {
    console.error("❌ Erreur POST /api/videos/process-async:", e);
    return res.status(500).json({
      error: "Erreur interne lors du lancement du montage (async).",
    });
  }
}

export async function getJobStatus(req, res) {
  const { jobId } = req.params;
  const userId = req.query?.userId;

  if (!jobId) return res.status(400).json({ error: "jobId est requis." });
  if (!userId) return res.status(400).json({ error: "userId est requis (query string)." });

  try {
    const job = await getVideoJob(jobId);

    const jobAfterDeadline = await failJobTimeoutIfNeeded(job);
    const safeJob = jobAfterDeadline || job;

    const caps = await computeEventCapabilities({ userId, eventId: safeJob.event_id });

    if (!caps?.role?.isCreator && !caps?.role?.isInvited) {
      return res.status(403).json({
        error: {
          code: "JOB_FORBIDDEN",
          message: "Vous n'êtes pas autorisé à consulter ce job.",
          status: 403,
        },
      });
    }

    const runtime = getVideoJobStatus(jobId);

    const mergedProgress =
      runtime && typeof runtime.percent === "number"
        ? Math.max(0, Math.min(100, Math.round(runtime.percent)))
        : safeJob.progress;

    return res.status(200).json({
      id: safeJob.id,
      eventId: safeJob.event_id,
      userId: safeJob.user_id,
      status: safeJob.status,
      message: safeJob.message || null,
      progress: mergedProgress,
      step: runtime?.step || safeJob.step || null,
      ffmpeg: runtime
        ? {
            percent: runtime.percent ?? null,
            step: runtime.step ?? null,
            outTimeSec: runtime.outTimeSec ?? null,
            totalSec: runtime.totalSec ?? null,
            updatedAt: runtime.updatedAt ?? null,
            error: runtime.error ?? null,
          }
        : null,
      requestedOptions: safeJob.requested_options,
      effectivePreset: safeJob.effective_preset,
      finalVideoUrl: safeJob.final_video_url || null,
      error: safeJob.error || null,
      createdAt: safeJob.created_at,
      startedAt: safeJob.started_at,
      finishedAt: safeJob.finished_at,
    });
  } catch (e) {
    console.error("❌ Erreur GET /api/videos/jobs/:jobId:", e);
    return res.status(500).json({
      error: "Erreur interne lors de la récupération du statut du job.",
    });
  }
}

// ===================== ADMIN =====================

export async function adminKillJob(req, res) {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "Accès non autorisé (admin key invalide)." });
  }

  const { jobId } = req.params;
  if (!jobId) return res.status(400).json({ error: "jobId est requis." });

  try {
    const job = await getVideoJob(jobId);
    if (!job) return res.status(404).json({ error: "Job introuvable." });

    await updateVideoJob(jobId, {
      status: "failed",
      progress: 0,
      error: "KILLED_BY_ADMIN",
      finished_at: new Date().toISOString(),
    });

    return res.status(200).json({ message: "Job marqué en failed.", jobId });
  } catch (e) {
    console.error("❌ adminKillJob error:", e);
    return res.status(500).json({ error: "Erreur interne (adminKillJob)." });
  }
}

export async function adminRetryJob(req, res) {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "Accès non autorisé (admin key invalide)." });
  }

  const { jobId } = req.params;
  if (!jobId) return res.status(400).json({ error: "jobId est requis." });

  try {
    const prev = await getVideoJob(jobId);
    if (!prev) return res.status(404).json({ error: "Job introuvable." });

    try {
      if (prev.status === "processing") {
        await updateVideoJob(jobId, {
          status: "failed",
          progress: prev.progress ?? 0,
          error: prev.error || "RETRY_REQUESTED",
          finished_at: new Date().toISOString(),
        });
      }
    } catch (_) {}

    const newJob = await createVideoJob({
      eventId: prev.event_id,
      userId: prev.user_id,
      requestedOptions: prev.requested_options || {},
      effectivePreset: prev.effective_preset || {},
    });

    await updateVideoJob(newJob.id, {
      status: "processing",
      progress: 5,
      started_at: new Date().toISOString(),
      error: null,
    });

    setImmediate(async () => {
      try {
        const eventId = newJob.event_id;

        const { data: videos, error: videosError } = await supabase
          .from("videos")
          .select("id")
          .eq("event_id", eventId);

        if (videosError) throw videosError;

        const videoIds = (videos || []).map((v) => v.id);
        const effectivePreset = newJob.effective_preset || {};

        const result = await processVideo(eventId, videoIds, effectivePreset, {
          jobId: newJob.id,
          deadlineMs: JOB_DEADLINE_MS,
          startedAtMs: Date.now(),
        });

        const finalVideoUrl = result?.finalVideoUrl || null;

        const latest = await getVideoJob(newJob.id);
        if (latest?.status === "processing") {
          await updateVideoJob(newJob.id, {
            status: "done",
            progress: 100,
            final_video_url: finalVideoUrl,
            finished_at: new Date().toISOString(),
            error: null,
          });
        }
      } catch (e) {
        console.error("❌ adminRetry montage failed:", e?.message || e);
        try {
          await updateVideoJob(newJob.id, {
            status: "failed",
            progress: 0,
            error: e?.message || "Erreur inconnue pendant le montage.",
            finished_at: new Date().toISOString(),
          });
        } catch (_) {}
      }
    });

    return res.status(202).json({
      message: "Retry lancé.",
      previousJobId: jobId,
      newJobId: newJob.id,
      status: "processing",
    });
  } catch (e) {
    console.error("❌ adminRetryJob error:", e);
    return res.status(500).json({ error: "Erreur interne (adminRetryJob)." });
  }
}
