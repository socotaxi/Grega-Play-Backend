// backend/services/capabilitiesService.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function isActivePremium(flag, expiresAt) {
  if (!flag) return false;
  if (!expiresAt) return true; // premium sans date = actif
  const exp = new Date(expiresAt).getTime();
  return Number.isFinite(exp) && exp > Date.now();
}

async function canAccessEventViaRpc({ eventId, userId }) {
  const { data, error } = await supabase.rpc("can_access_event", {
    event_id: eventId,
    user_id: userId,
  });

  if (error) {
    throw Object.assign(new Error("RPC can_access_event indisponible ou en erreur"), {
      status: 500,
      code: "ACCESS_RPC_FAILED",
      cause: error,
    });
  }

  if (typeof data === "boolean") return data;
  if (data && typeof data === "object" && "can_access" in data) return !!data.can_access;
  return !!data;
}

export async function computeEventCapabilities({ userId, eventId }) {
  // 1) Charger l'event
  const { data: event, error: eventErr } = await supabase
    .from("events")
    .select("id,user_id,is_premium_event,premium_event_expires_at,status,deadline")
    .eq("id", eventId)
    .maybeSingle();

  if (eventErr) {
    throw Object.assign(new Error("Erreur chargement événement"), {
      status: 500,
      code: "EVENT_LOAD_FAILED",
      cause: eventErr,
    });
  }
  if (!event) {
    throw Object.assign(new Error("Événement introuvable."), {
      status: 404,
      code: "EVENT_NOT_FOUND",
    });
  }

  // 2) Rôle / accès (creator OU participant via RPC)
  const isCreator = event.user_id === userId;
  let isInvited = false;

  if (!isCreator) {
    const canAccess = await canAccessEventViaRpc({ eventId, userId });
    isInvited = !!canAccess;
  } else {
    isInvited = true; // creator a accès
  }

  if (!isCreator && !isInvited) {
    throw Object.assign(new Error("Accès refusé à cet événement."), {
      status: 403,
      code: "EVENT_FORBIDDEN",
    });
  }

  // 3) Charger profil user
  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("id,is_premium_account,premium_account_expires_at")
    .eq("id", userId)
    .maybeSingle();

  if (profErr) {
    throw Object.assign(new Error("Erreur chargement profil"), {
      status: 500,
      code: "PROFILE_LOAD_FAILED",
      cause: profErr,
    });
  }
  if (!profile) {
    throw Object.assign(new Error("Profil introuvable."), {
      status: 404,
      code: "PROFILE_NOT_FOUND",
    });
  }

  const accountPremiumActive = isActivePremium(
    profile.is_premium_account,
    profile.premium_account_expires_at
  );
  const eventPremiumActive = isActivePremium(
    event.is_premium_event,
    event.premium_event_expires_at
  );

  // Premium effectif (compte OU event) : utile pour des features créateur (regen/qualité/limites montage)
const premiumActive = accountPremiumActive || eventPremiumActive;

// Multi-upload : UNIQUEMENT compte premium (et optionnellement créateur si tu veux)
const multiUploadActive = accountPremiumActive; // <- règle demandée


  // 4) Statut event (deadline/status)
  const now = Date.now();
  const deadlineTs = event.deadline ? new Date(event.deadline).getTime() : null;
  const isExpired = Number.isFinite(deadlineTs) ? deadlineTs < now : false;
  const isOpen = event.status === "open";
  const canAcceptUploads = isOpen && !isExpired;

  // 5) Règles actions/limits (source de vérité)
  const role = { isCreator, isInvited };

  const actions = {
    canUploadVideo: canAcceptUploads,
    canUploadMultipleVideos: multiUploadActive,
    canGenerateFinalVideo: isCreator,
    canRegenerateFinalVideo: isCreator && premiumActive,
  };

  const limits = {
    maxUploadsPerEvent: actions.canUploadMultipleVideos ? 999 : 1,
    maxClipsSelectableForFinal: premiumActive ? 999 : 5,
  };

  // 6) STATE (pour supprimer les fallbacks front)
  const { count: myUploadCount, error: countErr } = await supabase
    .from("videos")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .eq("user_id", userId);

  if (countErr) {
    throw Object.assign(new Error("Erreur lecture vidéos utilisateur"), {
      status: 500,
      code: "VIDEO_COUNT_FAILED",
      cause: countErr,
    });
  }

  const uploadLimit = limits.maxUploadsPerEvent;
  const hasReachedUploadLimit = (myUploadCount || 0) >= uploadLimit;

  const { data: latestVideo, error: latestErr } = await supabase
    .from("videos")
    .select("id,storage_path,created_at")
    .eq("event_id", eventId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) {
    throw Object.assign(new Error("Erreur lecture dernière vidéo utilisateur"), {
      status: 500,
      code: "LATEST_VIDEO_FAILED",
      cause: latestErr,
    });
  }

  return {
    role,
    actions,
    limits,
    premium: {
      active: premiumActive,
      account: {
        active: accountPremiumActive,
        expiresAt: profile.premium_account_expires_at || null,
      },
      event: {
        active: eventPremiumActive,
        expiresAt: event.premium_event_expires_at || null,
      },
    },
    state: {
      myUploadCount: myUploadCount || 0,
      uploadLimit,
      hasReachedUploadLimit,
      latestVideo: latestVideo || null,
      event: {
        isOpen,
        isExpired,
        deadline: event.deadline || null,
        status: event.status || null,
      },
    },
  };
}
