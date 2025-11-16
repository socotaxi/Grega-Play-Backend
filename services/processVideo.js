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

  // 2. Préparer temp dir
  const tempDir = path.join("tmp", eventId);
  fs.mkdirSync(tempDir, { recursive: true });

  // 3. Télécharger + normaliser vidéos
  console.log("➡️ Étape 3 : Téléchargement + Normalisation à 15s (H.264/AAC)...");
  const processedPaths = [];
  for (let i = 0; i < videos.length; i++) {
    const { publicUrl } = supabase.storage
      .from("videos")
      .getPublicUrl(videos[i].storage_path).data;

    console.log(`⬇️ Téléchargement : ${publicUrl}`);
    const localPath = path.join(tempDir, `video${i}_raw.mp4`);
    await downloadFile(publicUrl, localPath);

    // Ré-encodage homogène avec SAR/DAR forcés en 9:16 portrait
    const normalizedPath = path.join(tempDir, `video${i}.mp4`);
    await normalizeVideo(localPath, normalizedPath, 15); // tronque à 15s
    processedPaths.push(normalizedPath);
  }

  const outputPath = path.join(tempDir, "final.mp4");

  // 4. Concat avec filter_complex concat
  await runFFmpegFilterConcat(processedPaths, outputPath);

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

// ✅ Normalisation en 9:16 portrait
function normalizeVideo(inputPath, outputPath, maxSeconds = 15) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${inputPath}" -t ${maxSeconds} \
-vf "scale=720:1280,fps=30,setsar=1:1,setdar=9/16" \
-c:v libx264 -preset fast -crf 23 \
-c:a aac -b:a 128k -ar 48000 \
-vsync 2 -async 1 \
"${outputPath}"`;
    console.log("➡️ FFmpeg normalize:", cmd);
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg normalize error:", stderr || stdout);
        reject(new Error("Erreur FFmpeg (normalize)"));
      } else {
        console.log("✅ Vidéo normalisée:", outputPath);
        resolve();
      }
    });
  });
}

// ✅ Concat avec filter_complex concat
function runFFmpegFilterConcat(videoPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const inputs = videoPaths.map(p => `-i "${p}"`).join(" ");
    const filterInputs = videoPaths.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("");
    const cmd = `ffmpeg -y ${inputs} \
-filter_complex "${filterInputs}concat=n=${videoPaths.length}:v=1:a=1[outv][outa]" \
-map "[outv]" -map "[outa]" \
-c:v libx264 -preset fast -crf 23 \
-c:a aac -b:a 128k -ar 48000 \
"${outputPath}"`;

    console.log("➡️ FFmpeg filter_complex concat:", cmd);
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg concat error:", stderr || stdout);
        reject(new Error("Erreur FFmpeg (concat)"));
      } else {
        console.log("✅ FFmpeg concat avec filter_complex terminé");
        resolve();
      }
    });
  });
}
