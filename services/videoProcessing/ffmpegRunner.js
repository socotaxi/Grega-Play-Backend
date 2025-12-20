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

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse les lignes de progress FFmpeg (quand -progress pipe:2).
 * Format typique:
 * out_time_ms=123456
 * progress=continue|end
 */
function createProgressParser({ label, onProgress }) {
  let leftover = "";
  let lastOutTimeMs = null;
  let lastProgressEventAt = Date.now();

  const emit = (patch) => {
    if (typeof onProgress === "function") {
      try {
        onProgress({ label, ...patch });
      } catch (_) {
        // ne jamais casser FFmpeg si callback bug
      }
    }
  };

  const feed = (chunkStr) => {
    leftover += chunkStr;
    // Split lignes
    const lines = leftover.split(/\r?\n/);
    leftover = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;

      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();

      if (key === "out_time_ms") {
        const ms = safeNumber(val);
        if (ms !== null) {
          if (lastOutTimeMs === null || ms !== lastOutTimeMs) {
            lastOutTimeMs = ms;
            lastProgressEventAt = Date.now();
            emit({ outTimeMs: ms, outTimeSec: ms / 1000 });
          }
        }
      } else if (key === "progress") {
        lastProgressEventAt = Date.now();
        emit({ progress: val });
      }
    }
  };

  const getLastOutTimeMs = () => lastOutTimeMs;
  const getLastProgressEventAt = () => lastProgressEventAt;

  return { feed, getLastOutTimeMs, getLastProgressEventAt };
}

/**
 * Exécute une commande FFmpeg (cmd string via spawn(shell:true)),
 * avec:
 * - hard timeout
 * - watchdog d'inactivité
 * - watchdog "stalled progress" si -progress pipe:2 est utilisé
 * - parse optionnel de out_time_ms / progress=end
 *
 * Options:
 * - onProgress: ({label, outTimeMs, outTimeSec, progress}) => void
 * - expectProgress: true/false (si true, active le watchdog d'avancement)
 */
export function runCmdWithTimeout(cmd, label, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = getTimeoutMs();
    const inactivityMs = getInactivityMs();

    const { onProgress, expectProgress = false } = options;

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

    const progressParser = createProgressParser({ label, onProgress });

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

    const hardTimer = setTimeout(() => {
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

    // Watchdog: aucune activité texte
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
      clearTimeout(hardTimer);
      clearInterval(inactivityTimer);
      clearInterval(progressStallTimer);
      reject(err);
    }, 5000);

    // Watchdog: le progress n'avance plus (out_time_ms identique)
    // Un vrai “blocage” typique: FFmpeg sort encore du texte, mais out_time_ms reste figé.
    const progressStallTimer = setInterval(() => {
      if (!expectProgress) return;

      const lastEventAt = progressParser.getLastProgressEventAt();
      const stalledFor = Date.now() - lastEventAt;

      // Si on n'a eu AUCUN event progress depuis trop longtemps
      if (stalledFor >= inactivityMs) {
        killAll();
        const err = new Error(
          `FFmpeg stalled progress (${label}) après ${Math.round(inactivityMs / 1000)}s (out_time_ms n'avance plus)`
        );
        err.label = label;
        err.cmd = cmd;
        err.stderr_tail = tail(stderrBuf);
        err.stdout_tail = tail(stdoutBuf);
        clearTimeout(hardTimer);
        clearInterval(inactivityTimer);
        clearInterval(progressStallTimer);
        reject(err);
      }
    }, 5000);

    child.stdout?.on("data", (d) => {
      bump();
      const s = d.toString();
      stdoutBuf += s;
      // Si un jour tu mets -progress pipe:1, on saura le lire aussi
      if (expectProgress) progressParser.feed(s);
    });

    child.stderr?.on("data", (d) => {
      bump();
      const s = d.toString();
      stderrBuf += s;

      // IMPORTANT: avec -progress pipe:2, les key=value arrivent ici
      if (expectProgress) progressParser.feed(s);

      // tu avais déjà console.log, on garde (utile sur Railway)
      console.log(s.trimEnd());
    });

    child.on("error", (error) => {
      clearTimeout(hardTimer);
      clearInterval(inactivityTimer);
      clearInterval(progressStallTimer);
      killAll();
      const err = new Error(error?.message || `Erreur FFmpeg (${label})`);
      err.label = label;
      err.cmd = cmd;
      err.stderr_tail = tail(stderrBuf);
      err.stdout_tail = tail(stdoutBuf);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(hardTimer);
      clearInterval(inactivityTimer);
      clearInterval(progressStallTimer);

      if (code === 0) {
        // Dernier event: si progress=end n'est jamais arrivé, pas grave.
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
 * plan = { steps: [{ name, cmd, outputPath, expectProgress? }], outputs: { finalPath } }
 *
 * Compatibilité: si expectProgress absent => false.
 * Hook optionnel global: plan.onProgress(labelPatch)
 */
export async function runFfmpegPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("FFmpeg plan invalide (aucune étape).");
  }

  const planOnProgress = typeof plan.onProgress === "function" ? plan.onProgress : null;

  for (const step of plan.steps) {
    const name = step?.name || "step";
    const cmd = step?.cmd;

    if (!cmd || typeof cmd !== "string") {
      throw new Error(`Étape FFmpeg invalide: ${name}`);
    }

    console.log(`➡️ [FFmpeg] ${name}`);

    await runCmdWithTimeout(cmd, name, {
      expectProgress: !!step.expectProgress,
      onProgress: planOnProgress
        ? (p) => planOnProgress({ step: name, ...p })
        : null,
    });

    if (step.outputPath) {
      console.log(`✅ [FFmpeg] ${name} OK -> ${step.outputPath}`);
    } else {
      console.log(`✅ [FFmpeg] ${name} OK`);
    }
  }

  return plan.outputs || {};
}
