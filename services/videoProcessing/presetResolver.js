import { DEFAULT_PRESET } from "./presetDefaults.js";

const ALLOWED_TRANSITIONS = ["modern_1", "modern_2", "modern_3", "modern_4", "modern_5"];
const ALLOWED_MUSIC_MODES = ["none", "full", "intro_outro"];

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

export function resolvePreset({ caps, requestedOptions }) {
  const isPremium =
    Boolean(caps?.premium?.isPremiumAccountActive) ||
    Boolean(caps?.premium?.isPremiumEventActive);

  // base = défaut + merge simple
  const req = requestedOptions || {};

  const preset = JSON.parse(JSON.stringify(DEFAULT_PRESET));

  // Transition: premium = choix libre parmi 5, sinon forcée modern_1
  if (isPremium && ALLOWED_TRANSITIONS.includes(req.transition)) {
    preset.transition = req.transition;
  } else {
    preset.transition = "modern_1";
  }

  // Musique
  const reqMusicMode = req?.music?.mode;
  if (isPremium && ALLOWED_MUSIC_MODES.includes(reqMusicMode)) {
    preset.music.mode = reqMusicMode;
    preset.music.trackUrl = isNonEmptyString(req?.music?.trackUrl) ? req.music.trackUrl : null;
    preset.music.volume = clamp(req?.music?.volume, 0.05, 1.0);
  } else {
    preset.music.mode = "none";
    preset.music.trackUrl = null;
  }

  // Intro/outro custom (premium seulement)
  const canCustomizeIntroOutro = isPremium;

  if (canCustomizeIntroOutro) {
    const introType = req?.intro?.type;
    if (["default", "custom_image", "custom_text"].includes(introType)) {
      preset.intro.type = introType;
    }
    preset.intro.enabled = req?.intro?.enabled !== false;

    if (introType === "custom_image") {
      preset.intro.imageUrl = isNonEmptyString(req?.intro?.imageUrl) ? req.intro.imageUrl : null;
    }
    if (introType === "custom_text") {
      preset.intro.text = isNonEmptyString(req?.intro?.text) ? req.intro.text : null;
    }

    const outroType = req?.outro?.type;
    if (["default", "custom_image", "custom_text"].includes(outroType)) {
      preset.outro.type = outroType;
    }
    preset.outro.enabled = req?.outro?.enabled !== false;

    if (outroType === "custom_image") {
      preset.outro.imageUrl = isNonEmptyString(req?.outro?.imageUrl) ? req.outro.imageUrl : null;
    }
    if (outroType === "custom_text") {
      preset.outro.text = isNonEmptyString(req?.outro?.text) ? req.outro.text : null;
    }
  } else {
    preset.intro = { ...DEFAULT_PRESET.intro };
    preset.outro = { ...DEFAULT_PRESET.outro };
  }

  return preset;
}
