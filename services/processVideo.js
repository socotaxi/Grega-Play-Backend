import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { createClient } from "@supabase/supabase-js";
import https from "https";
import http from "http";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fetch from "cross-fetch";

global.fetch = fetch;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.SUPABASE_URL) {
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function processVideo(eventId) {
  console.log(`🎬 Démarrage du montage pour l'événement : ${eventId}`);

  // 🔄 Mettre l'événement en "processing"
  await supabase.from("events").update({ status: "processing" }).eq("id", eventId);

  // 1. Récupérer les vidéos
  console.log("➡️ Étape 1 : Récupération des vidéos depuis Supabase...");
  const { data: videos, error } = await supabase
    .from("videos")
    .select("storage_path")
    .eq("event_id", eventId);

  if (error) throw new Error("Impossible de récupérer les vidéos");
  if (!videos || videos.length === 0) {
    throw new Error("Aucune vidéo trouvée pour cet événement.");
  }
  console.log(`✅ ${videos.length} vidéos trouvées.`);

  // 2. Préparer temp dir (même dossier tmp que server.js)
  const tempRoot = path.join(__dirname, "tmp");
  if (!fs.existsSync(tempRoot)) {
    fs.mkdirSync(tempRoot, { recursive: true });
  }
  const tempDir = path.join(tempRoot, eventId);
  fs.mkdirSync(tempDir, { recursive: true });

  // 3. Télécharger + normaliser vidéos (par batch)
  console.log("➡️ Étape 3 : Téléchargement + Normalisation (portrait)...");
  const processedPaths = [];

  const CONCURRENCY = 2;

  for (let i = 0; i < videos.length; i += CONCURRENCY) {
    const slice = videos.slice(i, i + CONCURRENCY);

    const batchPromises = slice.map((video, idx) => {
      const globalIndex = i + idx;
      const { publicUrl } = supabase.storage
        .from("videos")
        .getPublicUrl(video.storage_path).data;

      const localPath = path.join(tempDir, `video${globalIndex}_raw.mp4`);
      const normalizedPath = path.join(tempDir, `video${globalIndex}.mp4`);

      return (async () => {
        console.log(`⬇️ Téléchargement (batch) : ${publicUrl}`);
        await downloadFile(publicUrl, localPath);
        await normalizeVideo(localPath, normalizedPath, 30);
        processedPaths.push(normalizedPath);
      })();
    });

    await Promise.all(batchPromises);
  }

  const outputPath = path.join(tempDir, "final.mp4");

  // 4. Concat avec fallback audio
  await runFFmpegFilterConcat(processedPaths, outputPath);

  // 4.1 Appliquer le filigrane sur la vidéo concaténée (avec fallback si ça plante)
  const noWmPath = path.join(tempDir, "final_no_wm.mp4");
  fs.renameSync(outputPath, noWmPath);

  try {
    await applyWatermark(noWmPath, outputPath);
  } catch (e) {
    console.error("⚠️ Erreur lors de l'application du watermark, on garde la vidéo sans filigrane.");
    console.error(e);

    // Si final.mp4 n'existe pas (échec du watermark), on revient au fichier sans watermark
    if (!fs.existsSync(outputPath) && fs.existsSync(noWmPath)) {
      fs.renameSync(noWmPath, outputPath);
    }
  }

  // 5. Upload final.mp4 (overwrite)
  const buffer = fs.readFileSync(outputPath);
  const supabasePath = `final_videos/${eventId}/final.mp4`;

  const { error: uploadError } = await supabase.storage
    .from("videos")
    .upload(supabasePath, buffer, {
      contentType: "video/mp4",
      upsert: true, // ⚡️ écrase si déjà présent
    });

  if (uploadError) throw new Error("Échec de l’upload dans Supabase Storage");

  const { publicUrl } = supabase.storage
    .from("videos")
    .getPublicUrl(supabasePath).data;

  // 6. Update event avec le nouveau lien
  await supabase
    .from("events")
    .update({
      final_video_url: publicUrl,
      status: "done",
    })
    .eq("id", eventId);

  console.log(`✅ Montage terminé : ${publicUrl}`);
  return { videoUrl: publicUrl };
}

// ---- Helpers ----
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

// ✅ Normalisation optimisée en 9:16 portrait
function normalizeVideo(inputPath, outputPath, maxSeconds = 15) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${inputPath}" -t ${maxSeconds} \
-vf "scale=576:1024:flags=bicubic,fps=25,setsar=1:1,setdar=9/16" \
-c:v libx264 -preset veryfast -crf 26 \
-c:a aac -b:a 96k -ar 44100 \
-movflags +faststart \
-threads 2 \
"${outputPath}"`;
    console.log("➡️ FFmpeg normalize (optimisé):", cmd);
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg normalize error:", stderr || stdout);
        reject(new Error("Erreur FFmpeg (normalize)"));
      } else {
        console.log("✅ Vidéo normalisée (optimisée):", outputPath);
        resolve();
      }
    });
  });
}

// ✅ Concat avec fallback si l'audio pose problème
function runFFmpegFilterConcat(videoPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const inputs = videoPaths.map(p => `-i "${p}"`).join(" ");

    const withAudioFilterInputs = videoPaths
      .map((_, i) => `[${i}:v:0][${i}:a:0]`)
      .join("");

    const videoOnlyFilterInputs = videoPaths
      .map((_, i) => `[${i}:v:0]`)
      .join("");

    // 1️⃣ Tentative avec audio
    const cmdWithAudio = `ffmpeg -y ${inputs} \
-filter_complex "${withAudioFilterInputs}concat=n=${videoPaths.length}:v=1:a=1[outv][outa]" \
-map "[outv]" -map "[outa]" \
-c:v libx264 -preset veryfast -crf 26 \
-c:a aac -b:a 96k -ar 44100 \
-movflags +faststart \
-threads 2 \
"${outputPath}"`;

    console.log("➡️ FFmpeg concat (avec audio):", cmdWithAudio);

    exec(cmdWithAudio, (error, stdout, stderr) => {
      if (!error) {
        console.log("✅ FFmpeg concat terminé (avec audio)");
      }
      if (!error) return resolve();

      console.error("❌ FFmpeg concat avec audio a échoué, on tente sans audio.");
      console.error("   Détails:", stderr || stdout);

      // 2️⃣ Fallback vidéo seule
      const cmdVideoOnly = `ffmpeg -y ${inputs} \
-filter_complex "${videoOnlyFilterInputs}concat=n=${videoPaths.length}:v=1[outv]" \
-map "[outv]" \
-c:v libx264 -preset veryfast -crf 26 \
-movflags +faststart \
-threads 2 \
"${outputPath}"`;

      console.log("➡️ FFmpeg concat (vidéo seule):", cmdVideoOnly);

      exec(cmdVideoOnly, (error2, stdout2, stderr2) => {
        if (error2) {
          console.error("❌ FFmpeg concat vidéo seule a aussi échoué.");
          console.error("   Détails:", stderr2 || stdout2);
          return reject(new Error("Erreur FFmpeg (concat)"));
        } else {
          console.log("✅ FFmpeg concat terminé (vidéo seule, sans audio)");
          return resolve();
        }
      });
    });
  });
}

// 🔥 Appliquer un filigrane sur la vidéo finale
function applyWatermark(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const watermarkPath = path.join(__dirname, "assets", "watermark.png");

    // ✅ Sécuriser : si le fichier watermark n'existe pas, on skip proprement
    if (!fs.existsSync(watermarkPath)) {
      console.warn("⚠️ Watermark introuvable, on génère la vidéo sans filigrane.");
      // On recopie simplement la vidéo d'entrée vers la sortie
      fs.copyFileSync(inputPath, outputPath);
      return resolve();
    }

    const cmd = `ffmpeg -y -i "${inputPath}" -i "${watermarkPath}" \
-filter_complex "overlay=main_w-overlay_w-30:main_h-overlay_h-30" \
-c:v libx264 -preset veryfast -crf 23 \
-movflags +faststart "${outputPath}"`;

    console.log("➡️ FFmpeg watermark:", cmd);

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg watermark error:", stderr || stdout);
        return reject(new Error("Erreur FFmpeg (watermark)"));
      } else {
        console.log("✅ Watermark appliqué :", outputPath);
        return resolve();
      }
    });
  });
}
