// backend/services/videoProcessing/validators.js

const DEFAULT_PRESET = {
  transition: "modern_1",
  transitionDuration: 0.3,

  music: {
    mode: "none", // none | intro_outro | full
    trackUrl: null, // (étape 8: deviendra storagePath + signedUrl)
    volume: 0.6,
  },

  intro: {
    enabled: true,
    type: "default", // default | custom_image | custom_text
    imageUrl: null,
    text: null,
  },

  outro: {
    enabled: true,
    type: "default",
    imageUrl: null,
    text: null,
  },

  // contraintes venant du backend capabilities
  constraints: {
    maxSelectableClips: null,
  },
};

const ALLOWED_TRANSITIONS = ["modern_1", "modern_2", "modern_3", "modern_4", "modern_5"];
const ALLOWED_MUSIC_MODES = ["none", "intro_outro", "full"];
const ALLOWED_INTRO_OUTRO_TYPES = ["default", "custom_image", "custom_text"];

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function clamp(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Valide + normalise le preset “effectivePreset” (déjà filtré par capabilities)
 * - Ne jette pas l’erreur pour tout : on normalise au maximum, et on garde
 *   une validation stricte seulement sur les cas dangereux (types impossibles).
 */
export function validateEffectivePreset(effectivePreset = {}) {
  const preset = deepClone(DEFAULT_PRESET);
  const src = effectivePreset && typeof effectivePreset === "object" ? effectivePreset : {};

  // constraints
  if (src.constraints && typeof src.constraints === "object") {
    const max = src.constraints.maxSelectableClips;
    preset.constraints.maxSelectableClips = Number.isFinite(max) ? max : null;
  }

  // transition
  if (isNonEmptyString(src.transition) && ALLOWED_TRANSITIONS.includes(src.transition.trim())) {
    preset.transition = src.transition.trim();
  } else if (isNonEmptyString(src.transition)) {
    // si jamais tu passes déjà une transition ffmpeg (xfade), on la laisse
    preset.transition = src.transition.trim();
  }

  preset.transitionDuration = clamp(src.transitionDuration, 0.1, 2.0, 0.3);

  // music
  if (src.music && typeof src.music === "object") {
    const mode = isNonEmptyString(src.music.mode) ? src.music.mode.trim() : "none";
    preset.music.mode = ALLOWED_MUSIC_MODES.includes(mode) ? mode : "none";

    preset.music.volume = clamp(src.music.volume, 0.05, 1.0, 0.6);

    // trackUrl: à ce stade on accepte http(s) pour garder ta logique actuelle
    // (étape 8: migration vers bucket premium-assets + signed URLs)
    preset.music.trackUrl = isNonEmptyString(src.music.trackUrl) ? src.music.trackUrl.trim() : null;
  }

  // intro/outro
  if (src.intro && typeof src.intro === "object") {
    preset.intro.enabled = src.intro.enabled !== false;

    const type = isNonEmptyString(src.intro.type) ? src.intro.type.trim() : "default";
    preset.intro.type = ALLOWED_INTRO_OUTRO_TYPES.includes(type) ? type : "default";

    preset.intro.imageUrl = isNonEmptyString(src.intro.imageUrl) ? src.intro.imageUrl.trim() : null;

    const txt = isNonEmptyString(src.intro.text) ? src.intro.text.trim() : null;
    preset.intro.text = txt ? txt.slice(0, 80) : null; // limite simple
  }

  if (src.outro && typeof src.outro === "object") {
    preset.outro.enabled = src.outro.enabled !== false;

    const type = isNonEmptyString(src.outro.type) ? src.outro.type.trim() : "default";
    preset.outro.type = ALLOWED_INTRO_OUTRO_TYPES.includes(type) ? type : "default";

    preset.outro.imageUrl = isNonEmptyString(src.outro.imageUrl) ? src.outro.imageUrl.trim() : null;

    const txt = isNonEmptyString(src.outro.text) ? src.outro.text.trim() : null;
    preset.outro.text = txt ? txt.slice(0, 80) : null;
  }

  return preset;
}
