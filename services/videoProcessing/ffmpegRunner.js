// backend/services/videoProcessing/ffmpegRunner.js
import { spawn } from "child_process";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 min
const DEFAULT_INACTIVITY_MS = 90 * 1000; // 90s (watchdog)

// Throttle pour éviter d'inonder la DB côté caller.
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

/**
 * Parse les lignes de progress FFmpeg (quand -progress pipe:2).
 *
 * Remarques importantes FFmpeg:
 * - out_time_us est en microsecondes
 * - out_time_ms est malheureusement aussi en microsecondes (malgré son nom)
 * - out_time = "HH:MM:SS.micro" (le plus lisible)
 *
 * On centralise tout ici, et on n'émet qu'au moment des événements "progress=continue|end".
 */
function createProgressParser({
  label,
  onProgress,
  throttleMs = DEFAULT_PROGRESS_THROTTLE_MS,
  totalDurationSec = null,
} = {}) {
  let leftover = "";

  let lastOutTime = null; // "00:00:12.345678"
  let lastOutTimeUsRaw = null; // "12345678" (µs)
  let lastOutTimeMsRaw = null; // "12345678" (µs, malgré le nom)

  let lastEmittedSec = 0; // monotone (ne recule jamais)
  let lastProgressEventAt = Date.now();

  // throttle
  let lastEmitAt = 0;
  const shouldEmitNow = (now, progressValue) => {
    if (progressValue === "end") return true; // toujours émettre la fin
    if (!throttleMs || throttleMs <= 0) return true;
    return now - lastEmitAt >= throttleMs;
  };

  const emit = (patch) => {
    if (typeof onProgress !== "function") return;
    try {
      onProgress({ label, ...patch });
    } catch (_) {
      // ne jamais casser FFmpeg si callback bug
    }
  };

  const parseHmsToSec = (s) => {
    if (!s || typeof s !== "string") return null;
    const m = s.trim().match(/^(\d+):([0-5]?\d):([0-5]?\d)(?:\.(\d+))?$/);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = Number(m[3]);
    const frac = m[4] ? Number("0." + m[4]) : 0;
    const sec = hh * 3600 + mm * 60 + ss + frac;
    return Number.isFinite(sec) ? sec : null;
  };

  const chooseOutTimeSec = () => {
    // 1) out_time (HH:MM:SS.micro) est le plus fiable
    const secFromOutTime = parseHmsToSec(lastOutTime);
    if (secFromOutTime != null) return secFromOutTime;

    // 2) out_time_us (µs)
    const usRaw = lastOutTimeUsRaw != null ? Number(lastOutTimeUsRaw) : NaN;
    if (Number.isFinite(usRaw)) {
      const sec = usRaw / 1_000_000;
      if (sec >= 0) return sec;
    }

    // 3) out_time_ms (⚠️ FFmpeg: µs malgré le nom)
    const msRaw = lastOutTimeMsRaw != null ? Number(lastOutTimeMsRaw) : NaN;
    if (Number.isFinite(msRaw)) {
      const sec = msRaw / 1_000_000;
      if (sec >= 0) return sec;
    }

    return null;
  };

  const computePercent = (sec) => {
    if (!Number.isFinite(sec) || !Number.isFinite(totalDurationSec) || !totalDurationSec) {
      return null;
    }
    const ratio = sec / totalDurationSec;
    if (!Number.isFinite(ratio)) return null;
    // On évite 100% tant qu'on n'a pas progress=end (sauf si on dépasse)
    const pct = Math.max(0, Math.min(99, Math.round(ratio * 100)));
    return pct;
  };

  const feed = (chunkStr) => {
    leftover += chunkStr;
    const arr = leftover.split(/\r?\n/);
    leftover = arr.pop() || "";

    for (const line of arr) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;

      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();

      // On garde la trace des champs de temps.
      if (key === "out_time") {
        lastOutTime = val;
        lastProgressEventAt = Date.now();
        continue;
      }
      if (key === "out_time_us") {
        lastOutTimeUsRaw = val;
        lastProgressEventAt = Date.now();
        continue;
      }
      if (key === "out_time_ms") {
        lastOutTimeMsRaw = val;
        lastProgressEventAt = Date.now();
        continue;
      }

      // On n'émet que sur progress=... (continue/end)
      if (key === "progress") {
        const now = Date.now();
        lastProgressEventAt = now;

        if (!shouldEmitNow(now, val)) continue;
        lastEmitAt = now;

        const tSec = chooseOutTimeSec();

        if (tSec != null) {
          // Monotone: ne jamais reculer (tolérance 250ms)
          if (tSec < lastEmittedSec - 0.25) {
            continue;
          }
          lastEmittedSec = Math.max(lastEmittedSec, tSec);
        }

        const outTimeSec = tSec == null ? null : lastEmittedSec;

        // percent optionnel (utile si tu veux éviter un 2e parseur ailleurs)
        const percent =
          val === "end"
            ? 100
            : outTimeSec == null
              ? null
              : computePercent(outTimeSec);

        emit({
          progress: val, // "continue" | "end"
          outTimeSec,
          percent,
          updatedAt: new Date(now).toISOString(),
        });
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
 * - parsing centralisé du progress (si expectProgress=true)
 *
 * Options:
 * - onProgress: ({label, progress, outTimeSec, percent, updatedAt}) => void
 * - expectProgress: true/false
 * - throttleMs: nombre (ms) (sinon env/default)
 * - totalDurationSec: pour calculer percent
 */
export function runCmdWithTimeout(cmd, label, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = getTimeoutMs();
    const inactivityMs = getInactivityMs();

    const {
      expectProgress = false,
      onProgress = null,
      throttleMs: throttleMsOpt = null,
      totalDurationSec = null,
    } = options;

    const throttleMs =
      throttleMsOpt == null ? getProgressThrottleMs() : Number(throttleMsOpt);

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
      totalDurationSec,
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

    // Watchdog: le progress ne sort plus (progress=... / out_time_...)
    const progressStallTimer = setInterval(() => {
      if (!expectProgress) return;

      const lastEventAt = progressParser.getLastProgressEventAt();
      const stalledFor = Date.now() - lastEventAt;

      if (stalledFor >= inactivityMs) {
        killAll();
        const err = new Error(
          `FFmpeg stalled progress (${label}) après ${Math.round(
            inactivityMs / 1000
          )}s (plus de progress=... / out_time_...)`
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
 * - On forward (step + label + progress + outTimeSec + percent + updatedAt)
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

    await runCmdWithTimeout(cmd, name, {
      expectProgress: !!step.expectProgress,
      totalDurationSec: step.totalDurationSec ?? null,
      throttleMs: step.throttleMs ?? null,
      onProgress: planOnProgress ? (p) => planOnProgress({ step: name, ...p }) : null,
    });

    if (step.outputPath) {
      console.log(`✅ [FFmpeg] ${name} OK -> ${step.outputPath}`);
    } else {
      console.log(`✅ [FFmpeg] ${name} OK`);
    }
  }

  return plan.outputs || {};
}
