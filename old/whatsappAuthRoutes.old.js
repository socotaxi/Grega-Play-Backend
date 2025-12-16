// whatsappAuthRoutes.js
// Routes pour login par téléphone avec OTP envoyé via WhatsApp
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

// -----------------------------------------------------------------------------
// CONFIG SUPABASE (admin, avec service_role)
// -----------------------------------------------------------------------------
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -----------------------------------------------------------------------------
// CONFIG WHATSAPP CLOUD API
// -----------------------------------------------------------------------------
const WHATSAPP_API_URL = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Durée de validité des OTP (en minutes)
const OTP_EXPIRATION_MINUTES = 10;

// -----------------------------------------------------------------------------
// HELPER - Générer un OTP à 6 chiffres
// -----------------------------------------------------------------------------
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// -----------------------------------------------------------------------------
// ROUTE 1 : POST /api/auth/request-otp-whatsapp
// - Reçoit un numéro de téléphone
// - Génère un OTP
// - Stocke le hash du OTP dans phone_otp_codes
// - Envoie le code via WhatsApp
// -----------------------------------------------------------------------------
router.post("/request-otp-whatsapp", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Téléphone requis" });
    }

    // Nettoyage simple du numéro
    const cleanedPhone = phone.replace(/\s+/g, "");

    // 1) Générer le code
    const otp = generateOtp();

    // 2) Calculer le hash du code pour le stocker (sécurité)
    const codeHash = crypto.createHash("sha256").update(otp).digest("hex");

    // 3) Calculer la date d'expiration
    const expiresAt = new Date(
      Date.now() + OTP_EXPIRATION_MINUTES * 60 * 1000
    ).toISOString();

    // 4) Enregistrer dans la table phone_otp_codes
    const { error: insertError } = await supabaseAdmin
      .from("phone_otp_codes")
      .insert({
        phone: cleanedPhone,
        code_hash: codeHash,
        expires_at: expiresAt,
        used: false,
      });

    if (insertError) {
      console.error("Erreur insert phone_otp_codes:", insertError);
      return res.status(500).json({ error: "Erreur serveur (enregistrement OTP)" });
    }

    // 5) Préparer le message WhatsApp
    const body = {
      messaging_product: "whatsapp",
      to: cleanedPhone, // ex: "+24206xxxxxxxx"
      type: "text",
      text: {
        body: `Votre code de connexion Grega Play est : ${otp}\nCe code est valide ${OTP_EXPIRATION_MINUTES} minutes.`,
      },
    };

    // 6) Appel à l'API WhatsApp Cloud
    const response = await fetch(WHATSAPP_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("Erreur WhatsApp API:", errorText);
      return res.status(500).json({ error: "Erreur envoi WhatsApp" });
    }

    // 7) OK
    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur request-otp-whatsapp:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// -----------------------------------------------------------------------------
// ROUTE 2 : POST /api/auth/verify-otp-whatsapp
// - Reçoit téléphone + code
// - Vérifie dans phone_otp_codes (non utilisé, non expiré, hash correct)
// - Marque "used = true"
// - TODO : connecter/créer l'utilisateur (à brancher selon ton choix)
// -----------------------------------------------------------------------------
router.post("/verify-otp-whatsapp", async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: "Téléphone et code requis" });
    }

    const cleanedPhone = phone.replace(/\s+/g, "");

    // 1) Hasher le code fourni
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");

    // 2) Récupérer le dernier OTP non utilisé qui correspond
    const { data: otpRecord, error: selectError } = await supabaseAdmin
      .from("phone_otp_codes")
      .select("*")
      .eq("phone", cleanedPhone)
      .eq("code_hash", codeHash)
      .eq("used", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (selectError || !otpRecord) {
      return res.status(400).json({ error: "Code invalide" });
    }

    // 3) Vérifier la date d'expiration
    const now = new Date();
    if (new Date(otpRecord.expires_at) < now) {
      return res.status(400).json({ error: "Code expiré" });
    }

    // 4) Marquer l'OTP comme utilisé
    const { error: updateError } = await supabaseAdmin
      .from("phone_otp_codes")
      .update({ used: true })
      .eq("id", otpRecord.id);

    if (updateError) {
      console.error("Erreur update OTP used:", updateError);
      // On ne bloque pas forcément l'utilisateur pour ça,
      // mais on le logue pour analyse.
    }

    // -------------------------------------------------------------------------
    // 5) ICI : LIAISON AVEC L'UTILISATEUR
    // -------------------------------------------------------------------------
    // À ce stade, le téléphone est vérifié.
    // Tu as trois grandes options :
    //
    // Option A : rester dans Supabase Auth (pseudo-email basé sur le téléphone)
    // Option B : système de session JWT maison (cookie HTTPOnly, etc.)
    // Option C : enregistrer seulement un "profil invité" lié au téléphone
    //
    // Pour ne pas te bloquer avec un mauvais choix, on renvoie pour l'instant :
    // { success: true, phone: cleanedPhone }
    //
    // Ensuite, on décidera ensemble comment :
    // - créer / retrouver le user Supabase
    // - créer une session (Supabase ou JWT)
    // - mettre à jour ton AuthContext côté frontend.

    return res.json({
      success: true,
      phone: cleanedPhone,
      message: "Code vérifié avec succès (étape suivante : lier au compte utilisateur).",
    });
  } catch (err) {
    console.error("Erreur verify-otp-whatsapp:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
