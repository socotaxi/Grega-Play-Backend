import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { createClient } from "@supabase/supabase-js";
import https from "https";
import http from "http";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

// 🔑 Pour résoudre __dirname en ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger .env si nécessaire (utile en local)
if (!process.env.SUPABASE_URL) {
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
}

// ✅ Chemin du logo watermark
const logoPath = path.resolve("assets/logo.png");
const logoExists = fs.existsSync(logoPath);

// 🔑 Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function processVideo(eventId) {
  console.log(`🎬 Démarrage du montage pour l'événement : ${eventId}`);

  // 1. Récupérer les vidéos liées à l’événement
  console.log("➡️ Étape 1 : Récupération des vidéos depuis Supabase...");
  const { data: videos, error } = await supabase
    .from("videos")
    .select("storage_path")
    .eq("event_id", eventId);

  if (error) {
    console.error("❌ Erreur Supabase:", error.message);
    throw new Error("Impossible de récupérer les vidéos");
  }
  if (!videos || videos.length === 0) {
    throw new Error("Aucune vidéo trouvée pour cet événement.");
  }
  console.log(`✅ ${videos.length} vidéos trouvées.`);

  // 2. Créer un dossier temporaire
  console.log("➡️ Étape 2 : Préparation des fichiers temporaires...");
  const tempDir = path.join("tmp", eventId);
  fs.mkdirSync(tempDir, { recursive: true });

  // 3. Télécharger les vidéos
  console.log("➡️ Étape 3 : Téléchargement des vidéos...");
  const downloadedPaths = [];
  for (let i = 0; i < videos.length; i++) {
    const { publicUrl } = supabase
      .storage
      .from("videos")
      .getPublicUrl(videos[i].storage_path).data;

    console.log(`⬇️ Téléchargement : ${publicUrl}`);
    const localPath = path.join(tempDir, `video${i}.mp4`);
    await downloadFile(publicUrl, localPath);
    downloadedPaths.push(localPath);
  }

  // 4. Créer le fichier list.txt
  console.log("➡️ Étape 4 : Création du fichier list.txt...");
  const listPath = path.join(tempDir, "list.txt");
  const ffmpegList = downloadedPaths
    .map((p) => `file '${path.resolve(p).replace(/\\/g, "/")}'`)
    .join("\n");

  console.log(`📄 Contenu de list.txt :\n${ffmpegList}`);
  fs.writeFileSync(listPath, ffmpegList);

  const concatPath = path.join(tempDir, "concat.mp4");
  const outputPath = path.join(tempDir, "final.mp4");

  // 5. Lancer FFmpeg concat
  console.log("➡️ Étape 5 : Concaténation avec FFmpeg...");
  await runFFmpegConcat(listPath.replace(/\\/g, "/"), concatPath);

  // 6. Watermark (si logo présent)
  if (logoExists) {
    console.log("➡️ Étape 6 : Application du watermark...");
    await runFFmpegWatermark(concatPath, logoPath, outputPath);
  } else {
    console.warn("⚠️ Logo watermark introuvable, on garde concat.mp4 comme final.mp4");
    fs.copyFileSync(concatPath, outputPath);
  }

  // 7. Upload final.mp4 dans Supabase
  console.log("➡️ Étape 7 : Upload du fichier final vers Supabase...");
  const buffer = fs.readFileSync(outputPath);
  const supabasePath = `final_videos/${eventId}.mp4`;

  const { error: uploadError } = await supabase.storage
    .from("videos")
    .upload(supabasePath, buffer, {
      contentType: "video/mp4",
      upsert: true,
    });

  if (uploadError) {
    console.error("❌ Erreur upload Supabase:", uploadError.message);
    throw new Error("Échec de l’upload dans Supabase Storage");
  }

  const { publicUrl } = supabase
    .storage
    .from("videos")
    .getPublicUrl(supabasePath).data;

  // 8. Mettre à jour l'événement
  console.log("➡️ Étape 8 : Mise à jour de la base de données...");
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

function runFFmpegWatermark(inputPath, logoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${inputPath}" -i "${logoPath}" -filter_complex "overlay=W-w-10:H-h-10" -c:a copy "${outputPath}"`;
    console.log("➡️ Commande FFmpeg watermark:", cmd);
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg watermark error:", stderr || stdout);
        reject(new Error("Erreur FFmpeg (watermark)"));
      } else {
        console.log("✅ FFmpeg watermark terminé");
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
