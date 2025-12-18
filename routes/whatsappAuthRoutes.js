// routes/whatsappAuthRoutes.js
import express from "express";
import crypto from "crypto";
//import fetch from "node-fetch"; <-- A suuprimer en Prod
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

// -----------------------------------------------------
// CONFIG SUPABASE (service_role)
// -----------------------------------------------------
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -----------------------------------------------------
// CONFIG WHATSAPP CLOUD API
// -----------------------------------------------------
const WHATSAPP_API_URL = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const OTP_EXPIRATION_MINUTES = 10;

const resp = await fetch(url, { method: "POST", headers, body });


// -----------------------------------------------------
// HELPERS
// -----------------------------------------------------

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizePhoneForEmail(phone) {
  // enlève tout sauf les chiffres
  const digits = phone.replace(/[^\d]/g, "");
  return `phone-${digits}@phone.gregaplay.com`;
}

function generateRandomPassword() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Associe un téléphone à un user Supabase avec pseudo-email.
 * - Cherche dans phone_users
 * - Si existe : met à jour le mot de passe du user Supabase
 * - Sinon : crée un user Supabase + insère dans phone_users
 * Retourne { pseudoEmail, password }
 */
async function getOrCreateUserForPhone(cleanedPhone) {
  const pseudoEmail = normalizePhoneForEmail(cleanedPhone);
  const newPassword = generateRandomPassword();

  // 1) Chercher si on a déjà un lien dans phone_users
  const { data: existingRows, error: selectError } = await supabaseAdmin
    .from("phone_users")
    .select("*")
    .eq("phone", cleanedPhone)
    .limit(1);

  if (selectError) {
    console.error("❌ Erreur select phone_users:", selectError);
    throw new Error("Erreur accès phone_users");
  }

  if (existingRows && existingRows.length > 0) {
    // Déjà un user pour ce téléphone
    const row = existingRows[0];

    // Mettre à jour le mot de passe de l'utilisateur Supabase
    const { error: updateError } =
      await supabaseAdmin.auth.admin.updateUserById(row.auth_user_id, {
        password: newPassword,
      });

    if (updateError) {
      console.error("❌ Erreur update user password:", updateError);
      throw new Error("Erreur mise à jour utilisateur");
    }

    return {
      pseudoEmail: row.pseudo_email,
      password: newPassword,
    };
  }

  // 2) Sinon : créer un user Supabase
  const { data: created, error: createError } =
    await supabaseAdmin.auth.admin.createUser({
      email: pseudoEmail,
      password: newPassword,
      email_confirm: true, // on considère l'email confirmé (pseudo-email)
      user_metadata: {
        phone: cleanedPhone,
        auth_type: "phone_whatsapp",
      },
    });

  if (createError || !created?.user) {
    console.error("❌ Erreur createUser:", createError);
    throw new Error("Erreur création utilisateur");
  }

  const userId = created.user.id;

  // 3) Enregistrer dans phone_users
  const { error: insertError } = await supabaseAdmin
    .from("phone_users")
    .insert({
      phone: cleanedPhone,
      auth_user_id: userId,
      pseudo_email: pseudoEmail,
    });

  if (insertError) {
    console.error("❌ Erreur insert phone_users:", insertError);
    throw new Error("Erreur enregistrement phone_users");
  }

  return {
    pseudoEmail,
    password: newPassword,
  };
}

// -----------------------------------------------------
// ROUTE 1 : POST /auth/request-otp-whatsapp
// -----------------------------------------------------
router.post("/request-otp-whatsapp", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Téléphone requis" });
    }

    const cleanedPhone = phone.replace(/\s+/g, "");

    const otp = generateOtp();
    const codeHash = crypto.createHash("sha256").update(otp).digest("hex");
    const expiresAt = new Date(
      Date.now() + OTP_EXPIRATION_MINUTES * 60 * 1000
    ).toISOString();

    // Stocker l’OTP
    const { error: insertError } = await supabaseAdmin
      .from("phone_otp_codes")
      .insert({
        phone: cleanedPhone,
        code_hash: codeHash,
        expires_at: expiresAt,
        used: false,
      });

    if (insertError) {
      console.error("❌ Erreur insert phone_otp_codes:", insertError);
      return res.status(500).json({ error: "Erreur serveur (OTP)" });
    }

    // Envoi WhatsApp
    const messageBody = {
      messaging_product: "whatsapp",
      to: cleanedPhone,
      type: "text",
      text: {
        body: `Votre code de connexion Grega Play est : ${otp}\nValable ${OTP_EXPIRATION_MINUTES} minutes.`,
      },
    };

    const response = await fetch(WHATSAPP_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messageBody),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("❌ Erreur WhatsApp API:", errorText);
      return res.status(500).json({ error: "Erreur envoi WhatsApp" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Erreur request-otp-whatsapp:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// -----------------------------------------------------
// ROUTE 2 : POST /auth/verify-otp-whatsapp
// -----------------------------------------------------
router.post("/verify-otp-whatsapp", async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: "Téléphone et code requis" });
    }

    const cleanedPhone = phone.replace(/\s+/g, "");
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");

    // 1) Vérifier OTP
    const { data: otpRecord, error } = await supabaseAdmin
      .from("phone_otp_codes")
      .select("*")
      .eq("phone", cleanedPhone)
      .eq("code_hash", codeHash)
      .eq("used", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !otpRecord) {
      return res.status(400).json({ error: "Code invalide" });
    }

    if (new Date(otpRecord.expires_at) < new Date()) {
      return res.status(400).json({ error: "Code expiré" });
    }

    // Marquer utilisé
    await supabaseAdmin
      .from("phone_otp_codes")
      .update({ used: true })
      .eq("id", otpRecord.id);

    // 2) Créer / récupérer l’utilisateur Supabase associé au téléphone
    const { pseudoEmail, password } = await getOrCreateUserForPhone(
      cleanedPhone
    );

    // 3) Retourner les identifiants au frontend
    return res.json({
      success: true,
      phone: cleanedPhone,
      pseudoEmail,
      password,
    });
  } catch (err) {
    console.error("❌ Erreur verify-otp-whatsapp:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
