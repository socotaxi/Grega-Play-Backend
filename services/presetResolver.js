// backend/services/presetResolver.js
import { assertPremiumAssetOwnership } from "./premiumAssetsGuard.js";

const DEFAULT_PRESET = {
  transition: "modern_1",
  transitionDuration: 0.3,
  intro: { enabled: true, type: "default", storagePath: null, text: null },
  outro: { enabled: true, type: "default", storagePath: null, text: null },
  music: { mode: "none", volume: 0.6, storagePath: null, ducking: false },

  // ✅ NEW: watermark option (default ON)
  watermark: { enabled: true },
};

function asNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeString(v, fallback = null) {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function normalizeRequestedOptions(requested) {
  const r = requested && typeof requested === "object" ? requested : {};

  return {
    transition: safeString(r.transition, DEFAULT_PRESET.transition),
    transitionDuration: clamp(asNumber(r.transitionDuration, DEFAULT_PRESET.transitionDuration), 0.1, 2),

    intro: {
      enabled: r?.intro?.enabled !== false,
      type: safeString(r?.intro?.type, DEFAULT_PRESET.intro.type),
      storagePath: safeString(r?.intro?.storagePath, null),
      text: safeString(r?.intro?.text, null),
    },

    outro: {
      enabled: r?.outro?.enabled !== false,
      type: safeString(r?.outro?.type, DEFAULT_PRESET.outro.type),
      storagePath: safeString(r?.outro?.storagePath, null),
      text: safeString(r?.outro?.text, null),
    },

    music: {
      mode: safeString(r?.music?.mode, DEFAULT_PRESET.music.mode), // none | intro_outro | full
      volume: clamp(asNumber(r?.music?.volume, DEFAULT_PRESET.music.volume), 0.05, 1),
      storagePath: safeString(r?.music?.storagePath, null),
      ducking: Boolean(r?.music?.ducking),
    },

    // ✅ NEW: watermark option
    // - default true
    // - if explicitly false => user wants to remove watermark (premium only)
    watermark: {
      enabled: r?.watermark?.enabled !== false,
    },
  };
}

function isAllowedTransition(t) {
  return ["modern_1", "modern_2", "modern_3", "modern_4", "modern_5"].includes(t);
}

function sanitizeForFreeTier(normalized) {
  return {
    ...DEFAULT_PRESET,
    transition: isAllowedTransition(normalized.transition) ? normalized.transition : DEFAULT_PRESET.transition,
    transitionDuration: DEFAULT_PRESET.transitionDuration,
    intro: { ...DEFAULT_PRESET.intro },
    outro: { ...DEFAULT_PRESET.outro },
    music: { ...DEFAULT_PRESET.music, mode: "none", storagePath: null, ducking: false },

    // ✅ Free tier: watermark forced ON
    watermark: { enabled: true },
  };
}

function sanitizeForPremium(normalized, ctx) {
  const transition = isAllowedTransition(normalized.transition)
    ? normalized.transition
    : DEFAULT_PRESET.transition;

  const musicMode = ["none", "intro_outro", "full"].includes(normalized.music.mode)
    ? normalized.music.mode
    : "none";

  const introType = ["default", "custom_image", "custom_text"].includes(normalized.intro.type)
    ? normalized.intro.type
    : "default";

  const outroType = ["default", "custom_image", "custom_text"].includes(normalized.outro.type)
    ? normalized.outro.type
    : "default";

  let introStoragePath = introType === "custom_image" ? normalized.intro.storagePath : null;
  let outroStoragePath = outroType === "custom_image" ? normalized.outro.storagePath : null;

  const introText = introType === "custom_text" ? normalized.intro.text : null;
  const outroText = outroType === "custom_text" ? normalized.outro.text : null;

  let musicStoragePath = musicMode !== "none" ? normalized.music.storagePath : null;

  // ✅ ownership checks (anti abus)
  try {
    if (introStoragePath) {
      introStoragePath = assertPremiumAssetOwnership({
        storagePath: introStoragePath,
        userId: ctx.userId,
        eventId: ctx.eventId,
        kind: "intro",
      });
    }
  } catch {
    introStoragePath = null;
  }

  try {
    if (outroStoragePath) {
      outroStoragePath = assertPremiumAssetOwnership({
        storagePath: outroStoragePath,
        userId: ctx.userId,
        eventId: ctx.eventId,
        kind: "outro",
      });
    }
  } catch {
    outroStoragePath = null;
  }

  try {
    if (musicStoragePath) {
      musicStoragePath = assertPremiumAssetOwnership({
        storagePath: musicStoragePath,
        userId: ctx.userId,
        eventId: ctx.eventId,
        kind: "music",
      });
    }
  } catch {
    musicStoragePath = null;
  }

  const ducking = Boolean(normalized.music.ducking);

  // ✅ NEW: watermark allowed OFF only for premium
  const watermarkEnabled = normalized?.watermark?.enabled !== false;

  return {
    transition,
    transitionDuration: clamp(normalized.transitionDuration, 0.1, 2),
    intro: {
      enabled: normalized.intro.enabled,
      type: introType,
      storagePath: introStoragePath,
      text: introText,
    },
    outro: {
      enabled: normalized.outro.enabled,
      type: outroType,
      storagePath: outroStoragePath,
      text: outroText,
    },
    music: {
      mode: musicMode,
      volume: clamp(normalized.music.volume, 0.05, 1),
      storagePath: musicStoragePath,
      ducking: musicMode === "none" ? false : ducking,
    },

    // ✅ NEW
    watermark: { enabled: watermarkEnabled },
  };
}

export function resolveEffectivePreset({ capabilities, requestedOptions, userId, eventId }) {
  const normalized = normalizeRequestedOptions(requestedOptions);

  const premium = capabilities?.premium || {};
  const actions = capabilities?.actions || {};

  const isEffectivePremium = Boolean(
    premium.isEffectivePremium ||
      premium.isPremium ||
      premium.isPremiumAccount ||
      premium.isPremiumEvent
  );

  const allowPremiumEditing = Boolean(isEffectivePremium || actions.canRegenerateFinalVideo);

  if (!allowPremiumEditing) {
    return sanitizeForFreeTier(normalized);
  }

  return sanitizeForPremium(normalized, { userId, eventId });
}

// ✅ Alias compat (si ton controller/ancien code attend resolvePreset)
export function resolvePreset({ caps, requestedOptions, userId, eventId }) {
  return resolveEffectivePreset({
    capabilities: caps,
    requestedOptions,
    userId,
    eventId,
  });
}
