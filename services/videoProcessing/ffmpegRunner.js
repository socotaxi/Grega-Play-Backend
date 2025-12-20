// backend/services/videoProcessing/ffmpegRunner.js
import { spawn } from "child_process";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 min
const DEFAULT_INACTIVITY_MS = 90 * 1000; // 90s (watchdog)

// Throttle pour éviter d'inonder la DB côté caller.
// (Option A: pas de colonne DB supplémentaire => on pousse un patch stable: outTimeSec + progress + updatedAt)
const DEFAULT_PROGRESS_THROTTLE_MS = 1200;

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

function getProgressThrottleMs() {
  const raw = process.env.FFMPEG_PROGRESS_THROTTLE_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PROGRESS_THROTTLE_MS;
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
 * out_time_ms=12345678   (⚠️ en réalité ce champ est en MICROsecondes)
 * progress=continue|end
 *
 * PATCH Option A:
 * - On stocke out_time_ms (microsecondes) et on n'émet qu'au moment de "progress=..."
 * - outTimeSec = out_time_ms / 1e6
 * - Throttle intégré (pour limiter les callbacks)
 */
function createProgressParser({ label, onProgress, throttleMs }) {
  let leftover = "";

  // FFmpeg: out_time_ms = microseconds
  let lastOutTimeUs = null;

  let lastProgressEventAt = Date.now();

  // throttle
  let lastEmitAt = 0;
  const shouldEmitNow = (now, progressValue) => {
    if (progressValue === "end") return true; // toujours émettre la fin
    if (!throttleMs || throttleMs <= 0) return true;
    return now - lastEmitAt >= throttleMs;
  };

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
        const us = safeNumber(val);
        if (us !== null) {
          lastOutTimeUs = us;
          lastProgressEventAt = Date.now();
        }
        continue;
      }

      if (key === "progress") {
        const now = Date.now();
        lastProgressEventAt = now;

        const outTimeSec =
          lastOutTimeUs === null ? null : Math.max(0, lastOutTimeUs / 1_000_000);

        if (shouldEmitNow(now, val)) {
          lastEmitAt = now;
          emit({
            // Option A: payload minimal et stable
            progress: val, // "continue" | "end"
            outTimeSec,
            updatedAt: new Date(now).toISOString(),
          });
        }
      }
    }
  };

  const getLastProgressEventAt = () => lastProgressEventAt;

  return { feed, getLastProgressEventAt };
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
 * - onProgress: ({label, progress, outTimeSec, updatedAt}) => void
 * - expectProgress: true/false (si true, active le watchdog d'avancement)
 */
export function runCmdWithTimeout(cmd, label, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = getTimeoutMs();
    const inactivityMs = getInactivityMs();

    const {
      onProgress,
      expectProgress = false,
    } = options;

    const throttleMs = getProgressThrottleMs();

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

    const progressParser = createProgressParser({
      label,
      onProgress,
      throttleMs,
    });

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

    // Watchdog: le progress ne sort plus (progress=... / out_time_ms...)
    const progressStallTimer = setInterval(() => {
      if (!expectProgress) return;

      const lastEventAt = progressParser.getLastProgressEventAt();
      const stalledFor = Date.now() - lastEventAt;

      if (stalledFor >= inactivityMs) {
        killAll();
        const err = new Error(
          `FFmpeg stalled progress (${label}) après ${Math.round(
            inactivityMs / 1000
          )}s (plus de progress=... / out_time_ms)`
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

      // utile sur Railway
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
 * Hook optionnel global: plan.onProgress(patch)
 * PATCH Option A:
 * - On forward (step + label + progress + outTimeSec + updatedAt)
 */
export async function runFfmpegPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("FFmpeg plan invalide (aucune étape).");
  }

  const planOnProgress =
    typeof plan.onProgress === "function" ? plan.onProgress : null;

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
