// backend/services/videoProcessing/ffmpegPlanBuilder.js
import path from "path";

const TRANSITION_MAP = {
  modern_1: "fadeblack",
  modern_2: "smoothleft",
  modern_3: "smoothright",
  modern_4: "circleopen",
  modern_5: "circleopen",
  modern_6: "radial",
};

function resolveTransitionName(v) {
  if (!v) return "fadeblack";
  const s = String(v).trim();
  return TRANSITION_MAP[s] || s; // si déjà un nom xfade valide, on garde
}

function escForFilter(str) {
  return String(str || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Construit un plan minimal :
 * 1) concat + transitions (xfade/acrossfade)
 * 2) intro/outro (+ musique intro_outro éventuellement)
 * 3) musique full (optionnel)
 * 4) watermark (optionnel)
 *
 * inputs: clipsPaths[], durations[]
 * assets: { introPath, outroPath, musicPath, watermarkPath, textIntroPng?, textOutroPng? }
 *
 * PATCH Option A:
 * - Ajout de expectProgress: true sur les étapes "longues"
 * - Ajout de "-progress pipe:2 -nostats" dans les cmd des étapes suivies
 *   (le parser est dans ffmpegRunner.js)
 */
export function buildFfmpegPlan({
  clipsPaths,
  durations,
  tempDir,
  preset,
  assets,
}) {
  if (!Array.isArray(clipsPaths) || clipsPaths.length === 0) {
    throw new Error("Aucune vidéo pour construire le plan.");
  }
  if (!Array.isArray(durations) || durations.length !== clipsPaths.length) {
    throw new Error("Durées invalides (durations doit matcher clipsPaths).");
  }

  const steps = [];

  const transition = resolveTransitionName(preset?.transition);
  const transDuration = Number(preset?.transitionDuration) || 0.3;

  const outConcat = path.join(tempDir, "plan_concat.mp4");
  const outIntroOutro = path.join(tempDir, "plan_intro_outro.mp4");
  const outMusicFull = path.join(tempDir, "plan_music_full.mp4");
  const outWatermark = path.join(tempDir, "plan_watermark.mp4");

  // -------------------------
  // Step 1: concat + transitions
  // -------------------------
  if (clipsPaths.length === 1) {
    const cmdSingle = `ffmpeg -nostdin -y -progress pipe:2 -nostats -i "${clipsPaths[0]}" \
-c:v libx264 -preset veryfast -crf 26 \
-c:a aac -b:a 96k -ar 44100 \
-movflags +faststart \
"${outConcat}"`;

    steps.push({
      name: "concat_single",
      cmd: cmdSingle,
      outputPath: outConcat,
      expectProgress: true,
    });
  } else {
    // offsets for xfade
    const offsets = [];
    for (let i = 0; i < clipsPaths.length - 1; i++) {
      const sumPrev = durations.slice(0, i + 1).reduce((a, b) => a + b, 0);
      const offset = sumPrev - transDuration * (i + 1);
      offsets.push(Math.max(0, offset));
    }

    const inputs = clipsPaths.map((p) => `-i "${p}"`).join(" ");

    const parts = [];
    for (let i = 0; i < clipsPaths.length; i++) {
      parts.push(
        `[${i}:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,setdar=9/16[v${i}]`
      );
      parts.push(
        `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`
      );
    }

    let vPrev = `[v0]`;
    let aPrev = `[a0]`;

    for (let i = 1; i < clipsPaths.length; i++) {
      const vCur = `[v${i}]`;
      const aCur = `[a${i}]`;

      const vOut = `[vxf${i}]`;
      const aOut = `[axf${i}]`;

      const offset = offsets[i - 1];

      parts.push(
        `${vPrev}${vCur}xfade=transition=${transition}:duration=${transDuration}:offset=${offset}${vOut}`
      );
      parts.push(
        `${aPrev}${aCur}acrossfade=d=${transDuration}:c1=tri:c2=tri${aOut}`
      );

      vPrev = vOut;
      aPrev = aOut;
    }

    const filterComplex = parts.join("; ");
    const cmd = `ffmpeg -nostdin -y -progress pipe:2 -nostats ${inputs} \
-filter_complex "${filterComplex}" \
-map "${vPrev}" -map "${aPrev}" \
-c:v libx264 -preset veryfast -crf 26 \
-c:a aac -b:a 96k -ar 44100 \
-movflags +faststart \
-threads 2 \
"${outConcat}"`;

    steps.push({
      name: "concat_transitions",
      cmd,
      outputPath: outConcat,
      expectProgress: true,
    });
  }

  // -------------------------
  // Step 2: intro/outro (+ musique intro_outro)
  // -------------------------
  const introEnabled = preset?.intro?.enabled !== false;
  const outroEnabled = preset?.outro?.enabled !== false;

  const introPath = assets?.introPath;
  const outroPath = assets?.outroPath;

  const musicMode = preset?.music?.mode || "none";
  const musicPath = assets?.musicPath || null;
  const musicVolume = Number(preset?.music?.volume) || 0.6;

  // si intro/outro absents → on copie juste
  if (!introEnabled && !outroEnabled) {
    const cmdCopy = `ffmpeg -nostdin -y -i "${outConcat}" -c copy "${outIntroOutro}"`;
    steps.push({
      name: "copy_no_intro_outro",
      cmd: cmdCopy,
      outputPath: outIntroOutro,
      expectProgress: false,
    });
  } else if (!introPath || !outroPath) {
    // fallback: juste copy
    const cmdCopy = `ffmpeg -nostdin -y -i "${outConcat}" -c copy "${outIntroOutro}"`;
    steps.push({
      name: "copy_missing_intro_outro_assets",
      cmd: cmdCopy,
      outputPath: outIntroOutro,
      expectProgress: false,
    });
  } else {
    const introDur = 3;
    const outroDur = 2;

    if (!musicPath || musicMode === "none" || musicMode === "full") {
      // sans musique ici (full sera géré après)
      const cmdNoMusic = `ffmpeg -nostdin -y -progress pipe:2 -nostats \
-loop 1 -t ${introDur} -i "${introPath}" \
-i "${outConcat}" \
-loop 1 -t ${outroDur} -i "${outroPath}" \
-filter_complex "\
[0:v]scale=720:1280:force_original_aspect_ratio=decrease,setsar=1:1,setdar=9/16,format=yuv420p[v0]; \
[1:v]scale=720:1280:force_original_aspect_ratio=decrease,setsar=1:1,setdar=9/16,format=yuv420p[v1]; \
[2:v]scale=720:1280:force_original_aspect_ratio=decrease,setsar=1:1,setdar=9/16,format=yuv420p[v2]; \
[v0][v1][v2]concat=n=3:v=1:a=0[v]; \
[1:a]adelay=${introDur * 1000}|${introDur * 1000}[voice]" \
-map "[v]" -map "[voice]" \
-c:v libx264 -preset veryfast -crf 26 \
-c:a aac -b:a 96k -ar 44100 \
-movflags +faststart \
"${outIntroOutro}"`;

      steps.push({
        name: "intro_outro_no_music",
        cmd: cmdNoMusic,
        outputPath: outIntroOutro,
        expectProgress: true,
      });
    } else {
      // musique intro_outro (bornée pour éviter durée énorme/infinie)
      const volume = Math.max(0.05, Math.min(1, musicVolume));

      // Durée approx du "core" (concat) en tenant compte des transitions
      const totalClips = durations.reduce((a, b) => a + b, 0);
      const coreDurApprox =
        clipsPaths.length > 1
          ? Math.max(0, totalClips - transDuration * (clipsPaths.length - 1))
          : Math.max(0, totalClips);

      // L'outro music démarre à la fin du core (après l'intro vidéo)
      const outroStartMs = Math.round((introDur + coreDurApprox) * 1000);

      const cmdMusic = `ffmpeg -nostdin -y -progress pipe:2 -nostats \
-loop 1 -t ${introDur} -i "${introPath}" \
-i "${outConcat}" \
-loop 1 -t ${outroDur} -i "${outroPath}" \
-i "${musicPath}" \
-filter_complex "\
[0:v]scale=720:1280:force_original_aspect_ratio=decrease,setsar=1:1,setdar=9/16,format=yuv420p[v0]; \
[1:v]scale=720:1280:force_original_aspect_ratio=decrease,setsar=1:1,setdar=9/16,format=yuv420p[v1]; \
[2:v]scale=720:1280:force_original_aspect_ratio=decrease,setsar=1:1,setdar=9/16,format=yuv420p[v2]; \
[v0][v1][v2]concat=n=3:v=1:a=0[v]; \
[1:a]adelay=${introDur * 1000}|${introDur * 1000}[voice]; \
[3:a]atrim=0:${introDur},asetpts=PTS-STARTPTS,volume=${volume}[m_intro]; \
[3:a]atrim=0:${outroDur},asetpts=PTS-STARTPTS,volume=${volume},adelay=${outroStartMs}|${outroStartMs}[m_outro]; \
[m_intro][m_outro]amix=inputs=2:duration=first[music]; \
[voice][music]amix=inputs=2:duration=first[a]" \
-map "[v]" -map "[a]" \
-c:v libx264 -preset veryfast -crf 26 \
-c:a aac -b:a 96k -ar 44100 \
-movflags +faststart \
-shortest \
"${outIntroOutro}"`;

      steps.push({
        name: "intro_outro_music_intro_outro",
        cmd: cmdMusic,
        outputPath: outIntroOutro,
        expectProgress: true,
      });
    }
  }

  // -------------------------
  // Step 3: musique full (optionnel)
  // -------------------------
  if (musicMode === "full" && musicPath) {
    const volume = Math.max(0.05, Math.min(1, musicVolume));
    const cmdFull = `ffmpeg -nostdin -y -progress pipe:2 -nostats -i "${outIntroOutro}" -stream_loop -1 -i "${musicPath}" \
-filter_complex "[1:a]volume=${volume}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[a]" \
-map 0:v -map "[a]" \
-c:v copy \
-c:a aac -b:a 128k -ar 44100 \
-movflags +faststart \
"${outMusicFull}"`;

    steps.push({
      name: "music_full",
      cmd: cmdFull,
      outputPath: outMusicFull,
      expectProgress: true,
    });
  } else {
    // copy forward
    const cmdCopy = `ffmpeg -nostdin -y -i "${outIntroOutro}" -c copy "${outMusicFull}"`;
    steps.push({
      name: "copy_no_full_music",
      cmd: cmdCopy,
      outputPath: outMusicFull,
      expectProgress: false,
    });
  }

  // -------------------------
  // Step 4: watermark (optionnel)
  // -------------------------
  const watermarkPath = assets?.watermarkPath;
  if (watermarkPath) {
    const cmdWm = `ffmpeg -nostdin -y -progress pipe:2 -nostats -i "${outMusicFull}" -i "${watermarkPath}" \
-filter_complex "overlay=W-w-20:H-h-20" \
-c:v libx264 -preset veryfast -crf 26 \
-c:a copy \
-movflags +faststart \
"${outWatermark}"`;

    steps.push({
      name: "watermark",
      cmd: cmdWm,
      outputPath: outWatermark,
      expectProgress: true,
    });
  } else {
    const cmdCopy = `ffmpeg -nostdin -y -i "${outMusicFull}" -c copy "${outWatermark}"`;
    steps.push({
      name: "copy_no_watermark",
      cmd: cmdCopy,
      outputPath: outWatermark,
      expectProgress: false,
    });
  }

  return {
    steps,
    outputs: {
      finalPath: outWatermark,
    },
  };
}
