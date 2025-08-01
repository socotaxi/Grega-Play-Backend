const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
}

const fs = require('fs');
const { exec } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { get } = require('https');
const { get: getHttp } = require('http');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function processVideo(eventId) {
  console.log(`🎬 Démarrage du montage pour l'événement : ${eventId}`);

  // 1. Récupérer les vidéos liées à l’événement
  const { data: videos, error } = await supabase
    .from('videos')
    .select('storage_path')
    .eq('event_id', eventId);

  if (error || !videos || videos.length === 0) {
    throw new Error("Aucune vidéo trouvée pour cet événement.");
  }

  // 2. Créer un dossier temporaire
  const tempDir = path.join('tmp', eventId);
  fs.mkdirSync(tempDir, { recursive: true });

  // 3. Télécharger les vidéos
  const downloadedPaths = [];
  for (let i = 0; i < videos.length; i++) {
    const { publicUrl } = supabase
      .storage
      .from('videos')
      .getPublicUrl(videos[i].storage_path).data;

    const localPath = path.join(tempDir, `video${i}.mp4`);
    await downloadFile(publicUrl, localPath);
    downloadedPaths.push(localPath);
  }

  // 4. Créer le fichier list.txt avec chemins absolus
  const listPath = path.join(tempDir, 'list.txt');
  const ffmpegList = downloadedPaths
    .map(p => `file '${path.resolve(p).replace(/\\/g, '/')}'`)
    .join('\n');

  console.log(`📄 Contenu de list.txt :\n${ffmpegList}`);
  fs.writeFileSync(listPath, ffmpegList);

  const outputPath = path.join(tempDir, 'final.mp4');

  // 5. Lancer FFmpeg
  await runFFmpegConcat(listPath.replace(/\\/g, '/'), outputPath);

  // 6. Upload final.mp4 dans Supabase
  const buffer = fs.readFileSync(outputPath);
  const supabasePath = `final_videos/${eventId}.mp4`;

  const { error: uploadError } = await supabase
    .storage
    .from('videos')
    .upload(supabasePath, buffer, {
      contentType: 'video/mp4',
      upsert: true
    });

  if (uploadError) {
    throw new Error('Échec de l’upload dans Supabase Storage');
  }

  const { publicUrl } = supabase
    .storage
    .from('videos')
    .getPublicUrl(supabasePath).data;

  // 7. Mettre à jour l'événement
  await supabase
    .from('events')
    .update({
      final_video_url: publicUrl,
      status: 'done'
    })
    .eq('id', eventId);

  console.log(`✅ Montage terminé : ${publicUrl}`);
  return { videoUrl: publicUrl };
}

function downloadFile(url, outputPath) {
  const protocol = url.startsWith('https') ? get : getHttp;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    protocol(url, response => {
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function runFFmpegConcat(listPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(stderr || stdout);
        reject(new Error('Erreur FFmpeg'));
      } else {
        resolve();
      }
    });
  });
}

module.exports = processVideo;
