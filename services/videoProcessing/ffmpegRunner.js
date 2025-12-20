// backend/services/videoProcessing/ffmpegRunner.js
import { spawn } from "child_process";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 min
const DEFAULT_INACTIVITY_MS = 90 * 1000; // 90s (watchdog)

function getTimeoutMs() {
  const raw = process.env.FFMPEG_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function getInactivityMs() {
  const raw = process.env.FFMPEG_INACTIVITY_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INACTIVITY_MS;
}

function tail(str, max = 6000) {
  const s = String(str || "");
  if (s.length <= max) return s;
  return s.slice(-max);
}

/**
 * Exécute une commande FFmpeg sous forme de string via spawn(shell:true),
 * avec logs streamés + timeout hard + kill (incl. process group sur Linux/Railway)
 * + watchdog d'inactivité (si aucun output pendant FFMPEG_INACTIVITY_MS).
 *
 * IMPORTANT: compatible avec l'existant (cmd string).
 */
function runCmdWithTimeout(cmd, label) {
  return new Promise((resolve, reject) => {
    const timeoutMs = getTimeoutMs();
    const inactivityMs = getInactivityMs();

    // detached sur Linux => permet de tuer tout le groupe (-pid)
    const useDetached = process.platform !== "win32";

    const child = spawn(cmd, {
      shell: true,
      detached: useDetached,
      windowsHide: true,
    });

    let stdoutBuf = "";
    let stderrBuf = "";

    let lastActivityAt = Date.now();
    const bump = () => {
      lastActivityAt = Date.now();
    };

    const killAll = () => {
      try {
        if (useDetached && child.pid) {
          // Kill process group (important quand shell:true lance un sous-process ffmpeg)
          process.kill(-child.pid, "SIGKILL");
        } else if (child.pid) {
          child.kill("SIGKILL");
        }
      } catch (_) {
        // ignore
      }
    };

    const timer = setTimeout(() => {
      killAll();
      const err = new Error(
        `Timeout FFmpeg (${label}) après ${Math.round(timeoutMs / 1000)}s`
      );
      err.label = label;
      err.cmd = cmd;
      err.stderr_tail = tail(stderrBuf);
      err.stdout_tail = tail(stdoutBuf);
      reject(err);
    }, timeoutMs);

    const inactivityTimer = setInterval(() => {
      const idle = Date.now() - lastActivityAt;
      if (idle < inactivityMs) return;
      killAll();
      const err = new Error(
        `FFmpeg inactive (${label}) après ${Math.round(inactivityMs / 1000)}s`
      );
      err.label = label;
      err.cmd = cmd;
      err.stderr_tail = tail(stderrBuf);
      err.stdout_tail = tail(stdoutBuf);
      clearTimeout(timer);
      clearInterval(inactivityTimer);
      reject(err);
    }, 5000);

    child.stdout?.on("data", (d) => {
      bump();
      const s = d.toString();
      stdoutBuf += s;
      // console.log(s.trimEnd());
    });

    child.stderr?.on("data", (d) => {
      bump();
      const s = d.toString();
      stderrBuf += s;
      // console.log(s.trimEnd());
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      clearInterval(inactivityTimer);
      killAll();
      const err = new Error(error?.message || `Erreur FFmpeg (${label})`);
      err.label = label;
      err.cmd = cmd;
      err.stderr_tail = tail(stderrBuf);
      err.stdout_tail = tail(stdoutBuf);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(inactivityTimer);

      if (code === 0) {
        return resolve({ stdout: stdoutBuf, stderr: stderrBuf });
      }

      const errMsg =
        tail(stderrBuf) ||
        tail(stdoutBuf) ||
        `FFmpeg a échoué (${label}) code=${code} signal=${signal}`;
      const err = new Error(errMsg);
      err.label = label;
      err.cmd = cmd;
      err.code = code;
      err.signal = signal;
      err.stderr_tail = tail(stderrBuf);
      err.stdout_tail = tail(stdoutBuf);
      return reject(err);
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
    await runCmdWithTimeout(cmd, name);

    if (step.outputPath) {
      console.log(`✅ [FFmpeg] ${name} OK -> ${step.outputPath}`);
    } else {
      console.log(`✅ [FFmpeg] ${name} OK`);
    }
  }

  return plan.outputs || {};
}
