// services/videoProcessing/videoPreset.schema.js
// Single source of truth for "video preset" structure (front -> controller -> processVideo)

export const TRANSITION_MAP = {
  modern_1: "fadeblack",
  modern_2: "smoothleft",
  modern_3: "smoothright",
  modern_4: "circleopen",
  modern_5: "pixelize",
};

export function safePreset(preset) {
  return preset && typeof preset === "object"
    ? preset
    : {
        transition: "modern_1",
        transitionDuration: 0.3,
        intro: { enabled: true, type: "default", storagePath: null, text: null },
        outro: { enabled: true, type: "default", storagePath: null, text: null },
        music: { mode: "none", volume: 0.6, storagePath: null, trackUrl: null, ducking: false },
      };
}

function clampNumber(v, { min, max, fallback }) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function asStringOrNull(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

export function resolveTransitionName(preset) {
  const key = preset?.transition;
  if (key && TRANSITION_MAP[key]) return TRANSITION_MAP[key];
  if (typeof key === "string" && key.trim()) return key.trim();
  return "fadeblack";
}

export function resolveTransitionDuration(preset) {
  return clampNumber(preset?.transitionDuration, { min: 0.1, max: 2, fallback: 0.3 });
}

/**
 * Normalise user-requested options coming from the frontend.
 * This function is safe to run in controller & processVideo.
 */
export function normalizeRequestedOptions(options) {
  const o = options && typeof options === "object" ? options : {};

  const intro = o.intro && typeof o.intro === "object" ? o.intro : {};
  const outro = o.outro && typeof o.outro === "object" ? o.outro : {};
  const music = o.music && typeof o.music === "object" ? o.music : {};

  const norm = {
    transition: typeof o.transition === "string" ? o.transition.trim() : "modern_1",
    transitionDuration: resolveTransitionDuration(o),
    intro: {
      enabled: intro.enabled !== false,
      type: typeof intro.type === "string" ? intro.type : "default",
      storagePath: asStringOrNull(intro.storagePath) || asStringOrNull(intro.imageUrl) || null,
      text: asStringOrNull(intro.text) || null,
    },
    outro: {
      enabled: outro.enabled !== false,
      type: typeof outro.type === "string" ? outro.type : "default",
      storagePath: asStringOrNull(outro.storagePath) || asStringOrNull(outro.imageUrl) || null,
      text: asStringOrNull(outro.text) || null,
    },
    music: {
      mode: typeof music.mode === "string" ? music.mode : "none",
      storagePath: asStringOrNull(music.storagePath) || asStringOrNull(music.path) || null,
      trackUrl: asStringOrNull(music.trackUrl) || null,
      volume: clampNumber(music.volume, { min: 0, max: 1, fallback: 0.6 }),
      ducking: Boolean(music.ducking),
    },
  };

  // Enforce allowed modes
  if (!["none", "full", "intro_outro"].includes(norm.music.mode)) {
    norm.music.mode = "none";
  }

  // If no source provided, force none
  if (norm.music.mode !== "none" && !norm.music.storagePath && !norm.music.trackUrl) {
    norm.music.mode = "none";
  }

  return norm;
}

/**
 * Normalise/secure the effective preset passed into processVideo().
 */
export function normalizeEffectivePreset(effectivePreset) {
  const base = safePreset(effectivePreset);
  const req = normalizeRequestedOptions(base);

  // Keep any extra fields from effectivePreset (constraints, etc.)
  const merged = { ...base, ...req };
  if (base?.constraints) merged.constraints = base.constraints;

  return merged;
}

/**
 * Detect whether requested options are premium (so controller can decide overlay policy).
 */
export function isPremiumPresetRequested(requestedOptions) {
  const o = normalizeRequestedOptions(requestedOptions);
  return (
    (o.music?.mode && o.music.mode !== "none") ||
    (o.transition && o.transition !== "modern_1") ||
    (o.intro?.type && o.intro.type !== "default") ||
    (o.outro?.type && o.outro.type !== "default")
  );
}
