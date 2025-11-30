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

export default async function processVideo(eventId, selectedVideoIds) {
  console.log(`🎬 Démarrage du montage pour l'événement : ${eventId}`);

  // 🔄 Mettre l'événement en "processing"
  await supabase
    .from("events")
    .update({ status: "processing" })
    .eq("id", eventId);

  if (!Array.isArray(selectedVideoIds) || selectedVideoIds.length < 2) {
    throw new Error(
      "Au moins 2 vidéos doivent être sélectionnées pour le montage."
    );
  }

  // 1. Récupérer les vidéos sélectionnées
  console.log(
    "➡️ Étape 1 : Récupération des vidéos sélectionnées depuis Supabase..."
  );
  const { data: videos, error } = await supabase
    .from("videos")
    .select("id, storage_path")
    .eq("event_id", eventId)
    .in("id", selectedVideoIds);

  if (error) throw new Error("Impossible de récupérer les vidéos sélectionnées");
  if (!videos || videos.length === 0) {
    throw new Error("Aucune vidéo trouvée pour cet événement.");
  }

  // Réordonner pour respecter l'ordre de sélection
  const orderedVideos = selectedVideoIds
    .map((id) => videos.find((v) => v.id === id))
    .filter(Boolean);

  if (!orderedVideos.length) {
    throw new Error(
      "Impossible de faire correspondre les vidéos sélectionnées."
    );
  }

  console.log(
    `✅ ${orderedVideos.length} vidéos sélectionnées pour le montage.`
  );

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

  for (let i = 0; i < orderedVideos.length; i += CONCURRENCY) {
    const slice = orderedVideos.slice(i, i + CONCURRENCY);

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

  // 3.1 Récupérer la durée de chaque vidéo normalisée (pour calculer les offsets xfade)
  console.log("➡️ Étape 3.1 : Récupération des durées (ffprobe)...");
  const durations = [];
  for (const p of processedPaths) {
    const d = await getVideoDuration(p);
    durations.push(d);
  }

  const outputPath = path.join(tempDir, "final.mp4");

  // 4. Concat avec transitions modernes (xfade) + audio crossfade
  await runFFmpegFilterConcat(
    processedPaths,
    durations,
    outputPath,
    "fadeblack", // transition par défaut pour compte gratuit
    0.3 // durée de la transition
  );

  // 4.1 Appliquer le filigrane sur la vidéo concaténée (avec fallback si ça plante)
  const noWmPath = path.join(tempDir, "final_no_wm.mp4");
  fs.renameSync(outputPath, noWmPath);

  try {
    await applyWatermark(noWmPath, outputPath);
  } catch (e) {
    console.error(
      "⚠️ Erreur lors de l'application du watermark, on garde la vidéo sans filigrane."
    );
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
        return reject(
          new Error(`Échec téléchargement ${url}: ${res.statusCode}`)
        );
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });

    req.on("error", reject);
    req.end();
  });
}

// ✅ Normalisation optimisée en 9:16 portrait
function normalizeVideo(inputPath, outputPath, maxSeconds = 30) {
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

// ✅ Récupérer la durée d'une vidéo (ffprobe)
function getVideoDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ ffprobe error:", stderr || stdout);
        return reject(new Error("Erreur ffprobe (duration)"));
      }
      const duration = parseFloat(String(stdout).trim());
      if (isNaN(duration)) {
        return reject(new Error("Durée vidéo invalide"));
      }
      resolve(duration);
    });
  });
}

// ✅ Concat + transitions xfade (vidéo) + acrossfade (audio)
function runFFmpegFilterConcat(
  videoPaths,
  durations,
  outputPath,
  transition = "fadeblack",
  transDuration = 0.3
) {
  return new Promise((resolve, reject) => {
    const n = videoPaths.length;
    if (!Array.isArray(videoPaths) || n === 0) {
      return reject(new Error("Aucune vidéo à concaténer"));
    }

    // Sécurité sur la taille du tableau des durées
    if (!Array.isArray(durations) || durations.length !== n) {
      return reject(
        new Error(
          "Le tableau des durées ne correspond pas au nombre de vidéos."
        )
      );
    }

    const inputs = videoPaths.map((p) => `-i "${p}"`).join(" ");

    if (n === 1) {
      // Cas trivial : une seule vidéo (pas de transition à appliquer)
      const cmdSingle = `ffmpeg -y -i "${videoPaths[0]}" \
-c:v libx264 -preset veryfast -crf 26 \
-c:a aac -b:a 96k -ar 44100 \
-movflags +faststart \
"${outputPath}"`;

      console.log("➡️ FFmpeg concat (single):", cmdSingle);
      exec(cmdSingle, (error, stdout, stderr) => {
        if (error) {
          console.error("❌ FFmpeg single error:", stderr || stdout);
          return reject(new Error("Erreur FFmpeg (single concat)"));
        }
        console.log("✅ FFmpeg terminé (single)");
        return resolve();
      });
      return;
    }

    // Calcul des offsets pour xfade
    // offset0 = d0 - t
    // offset1 = d0 + d1 - 2t
    // offset2 = d0 + d1 + d2 - 3t, etc.
    const offsets = [];
    let total = durations[0];

    for (let i = 0; i < n - 1; i++) {
      const off = Math.max(total - transDuration, 0);
      offsets.push(off);
      total = total + durations[i + 1] - transDuration;
    }

    const filterParts = [];
    let vPrev = "[0:v]";
    let aPrev = "[0:a]";

    for (let i = 1; i < n; i++) {
      const vCur = `[${i}:v]`;
      const aCur = `[${i}:a]`;

      const vOut = i === n - 1 ? "[vout]" : `[v${i}]`;
      const aOut = i === n - 1 ? "[aout]" : `[a${i}]`;

      const offset = offsets[i - 1];

      // Vidéo : xfade avec offset calculé
      filterParts.push(
        `${vPrev}${vCur} xfade=transition=${transition}:duration=${transDuration}:offset=${offset} ${vOut}`
      );

      // Audio : crossfade simple (acrossfade)
      filterParts.push(
        `${aPrev}${aCur} acrossfade=d=${transDuration}:c1=tri:c2=tri ${aOut}`
      );

      vPrev = vOut;
      aPrev = aOut;
    }

    const filterComplex = filterParts.join("; ");

    const cmd = `ffmpeg -y ${inputs} \
-filter_complex "${filterComplex}" \
-map "[vout]" -map "[aout]" \
-c:v libx264 -preset veryfast -crf 26 \
-c:a aac -b:a 96k -ar 44100 \
-movflags +faststart \
-threads 2 \
"${outputPath}"`;

    console.log("➡️ FFmpeg concat + transitions:", cmd);

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg transitions error:", stderr || stdout);
        return reject(new Error("Erreur FFmpeg (transitions concat)"));
      } else {
        console.log("✅ Vidéo concaténée avec transitions :", outputPath);
        return resolve();
      }
    });
  });
}

// 🔥 Appliquer un filigrane sur la vidéo finale
function applyWatermark(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const watermarkPath = path.join(__dirname, "assets", "watermark.png");

    // ✅ Sécuriser : si le fichier watermark n'existe pas, on skip proprement
    if (!fs.existsSync(watermarkPath)) {
      console.warn(
        "⚠️ Watermark introuvable, on génère la vidéo sans filigrane."
      );
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
