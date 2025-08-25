import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { createClient } from "@supabase/supabase-js";
import https from "https";
import http from "http";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

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

  // 3. Télécharger et tronquer les vidéos à 10s
  console.log("➡️ Étape 3 : Téléchargement + Tronquage à 10s...");
  const processedPaths = [];
  for (let i = 0; i < videos.length; i++) {
    const { publicUrl } = supabase.storage
      .from("videos")
      .getPublicUrl(videos[i].storage_path).data;

    console.log(`⬇️ Téléchargement : ${publicUrl}`);
    const localPath = path.join(tempDir, `video${i}_raw.mp4`);
    await downloadFile(publicUrl, localPath);

    // Tronquer à 10s
    const trimmedPath = path.join(tempDir, `video${i}.mp4`);
    await trimVideo(localPath, trimmedPath, 10);
    processedPaths.push(trimmedPath);
  }

  // 4. Créer list.txt
  const listPath = path.join(tempDir, "list.txt");
  const ffmpegList = processedPaths
    .map((p) => `file '${path.resolve(p).replace(/\\/g, "/")}'`)
    .join("\n");
  fs.writeFileSync(listPath, ffmpegList);

  const concatPath = path.join(tempDir, "concat.mp4");
  const outputPath = path.join(tempDir, "final.mp4");

  // 5. Concat
  await runFFmpegConcat(listPath.replace(/\\/g, "/"), concatPath);

  // 6. Copier concat.mp4 → final.mp4
  fs.copyFileSync(concatPath, outputPath);

  // 7. Upload final.mp4
  const buffer = fs.readFileSync(outputPath);
  const supabasePath = `final_videos/${eventId}.mp4`;

  const { error: uploadError } = await supabase.storage
    .from("videos")
    .upload(supabasePath, buffer, {
      contentType: "video/mp4",
      upsert: true,
    });
  if (uploadError) throw new Error("Échec de l’upload dans Supabase Storage");

  const { publicUrl } = supabase.storage
    .from("videos")
    .getPublicUrl(supabasePath).data;

  // 8. Update event
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

// ✅ Nouveau helper : tronquer avec FFmpeg
function trimVideo(inputPath, outputPath, maxSeconds = 10) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${inputPath}" -t ${maxSeconds} -c copy "${outputPath}"`;
    console.log("➡️ FFmpeg trim:", cmd);
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg trim error:", stderr || stdout);
        reject(new Error("Erreur FFmpeg (trim)"));
      } else {
        console.log("✅ Vidéo tronquée:", outputPath);
        resolve();
      }
    });
  });
}

function runFFmpegConcat(listPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
    console.log("➡️ Commande FFmpeg concat:", cmd);
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg concat error:", stderr || stdout);
        reject(new Error("Erreur FFmpeg (concat)"));
      } else {
        console.log("✅ FFmpeg concat terminé");
        resolve();
      }
    });
  });
}
