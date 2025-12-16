console.log("🟣 premiumService LOADED");

// services/premiumService.js
// Source de vérité PREMIUM – étape 4 (upload uniquement)

// Vérifie si un profil utilisateur a un compte Premium actif
export function isAccountPremium(profile) {
  if (!profile) return false;

  // Compatibilité : ancien flag + nouveau flag
  const flaggedPremium =
    profile.is_premium_account === true || profile.is_premium === true;

  // Si pas de date d'expiration → considéré actif
  const notExpired =
    !profile.premium_account_expires_at ||
    new Date(profile.premium_account_expires_at) > new Date();

  return flaggedPremium && notExpired;
}

// Capacités liées UNIQUEMENT à l'upload (règles actuelles)
export function getUploadCapabilities({ participantProfile }) {
  console.log("🟣 getUploadCapabilities CALLED", {
    is_premium_account: participantProfile?.is_premium_account,
    is_premium: participantProfile?.is_premium,
    expires: participantProfile?.premium_account_expires_at,
  });

  const accountPremium = isAccountPremium(participantProfile);

  console.log("🟣 accountPremium =", accountPremium);

  return {
    accountPremium,
    canUploadMultipleVideos: accountPremium,
  };
}

export function getCapabilities({ accountPremium, isCreator }) {
  return {
    accountPremium,
    canUploadMultipleVideos: accountPremium || isCreator,
    canRegenerateFinalVideo: accountPremium || isCreator,
    maxVideosForFinal: accountPremium ? 999 : 5,
  };
}

