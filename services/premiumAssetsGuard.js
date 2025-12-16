// backend/services/premiumAssetsGuard.js

/**
 * Objectif: empêcher qu’un utilisateur envoie un storagePath qui pointe vers un asset
 * appartenant à quelqu’un d’autre (anti-abus).
 *
 * Hypothèse recommandée: premium-assets stocke sous:
 * - users/<userId>/intro/xxx.png
 * - users/<userId>/outro/xxx.png
 * - users/<userId>/music/xxx.mp3
 * ou
 * - events/<eventId>/intro/xxx.png (si assets liés à un event)
 */

function isString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function normalizePath(p) {
  return String(p).replace(/^\/+/, "").replace(/\\/g, "/");
}

function allowedPrefixForKind({ userId, eventId, kind }) {
  // tu peux durcir ici selon ta logique
  const k = String(kind || "").toLowerCase();

  const userPrefix = `users/${userId}/${k}/`;
  const userAnyKindPrefix = `users/${userId}/`;

  const eventPrefix = eventId ? `events/${eventId}/${k}/` : null;
  const eventAnyPrefix = eventId ? `events/${eventId}/` : null;

  return {
    userPrefix,
    userAnyKindPrefix,
    eventPrefix,
    eventAnyPrefix,
  };
}

export function assertPremiumAssetOwnership({ storagePath, userId, eventId, kind }) {
  if (!isString(storagePath)) return null;

  const p = normalizePath(storagePath);

  // Refuse path traversal
  if (p.includes("..")) {
    const err = new Error("storagePath invalide.");
    err.code = "ASSET_PATH_INVALID";
    throw err;
  }

  if (!isString(userId)) {
    const err = new Error("userId manquant pour valider l’asset.");
    err.code = "ASSET_USER_MISSING";
    throw err;
  }

  const prefixes = allowedPrefixForKind({ userId, eventId, kind });

  const ok =
    p.startsWith(prefixes.userPrefix) ||
    p.startsWith(prefixes.userAnyKindPrefix) ||
    (prefixes.eventPrefix && p.startsWith(prefixes.eventPrefix)) ||
    (prefixes.eventAnyPrefix && p.startsWith(prefixes.eventAnyPrefix));

  if (!ok) {
    const err = new Error("Asset non autorisé (ownership).");
    err.code = "ASSET_OWNERSHIP_DENIED";
    throw err;
  }

  return p;
}
