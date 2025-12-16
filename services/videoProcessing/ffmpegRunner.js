// backend/services/videoProcessing/ffmpegRunner.js
import { exec } from "child_process";

function execPromise(cmd, label) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        const msg = (stderr || stdout || "").toString();
        const err = new Error(msg || `Erreur FFmpeg (${label})`);
        err.label = label;
        err.cmd = cmd;
        return reject(err);
      }
      return resolve({ stdout, stderr });
    });
  });
}

/**
 * Exécute un plan FFmpeg séquentiel.
 * plan = { steps: [{ name, cmd, outputPath }], outputs: { finalPath } }
 */
export async function runFfmpegPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("FFmpeg plan invalide (aucune étape).");
  }

  for (const step of plan.steps) {
    const name = step?.name || "step";
    const cmd = step?.cmd;

    if (!cmd || typeof cmd !== "string") {
      throw new Error(`Étape FFmpeg invalide: ${name}`);
    }

    console.log(`➡️ [FFmpeg] ${name}`);
    // log soft (sans noyer les logs)
    // console.log(cmd);

    await execPromise(cmd, name);

    if (step.outputPath) {
      console.log(`✅ [FFmpeg] ${name} OK -> ${step.outputPath}`);
    } else {
      console.log(`✅ [FFmpeg] ${name} OK`);
    }
  }

  return plan.outputs || {};
}
