// routes/auth.js
import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * POST /api/auth/verify-otp-whatsapp
 * Body: { phone: "+242xxxxxxxx", code: "123456" }
 */
router.post("/verify-otp-whatsapp", async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: "Téléphone et code requis" });
    }

    // 1) Hasher le code reçu
    const hash = crypto.createHash("sha256").update(code).digest("hex");

    // 2) Chercher le dernier OTP valide pour ce téléphone
    const { data: otpRecord, error } = await supabaseAdmin
      .from("phone_otp_codes")
      .select("*")
      .eq("phone", phone)
      .eq("code_hash", hash)
      .eq("used", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !otpRecord) {
      return res.status(400).json({ error: "Code invalide" });
    }

    // 3) Vérifier l'expiration
    const now = new Date();
    if (new Date(otpRecord.expires_at) < now) {
      return res.status(400).json({ error: "Code expiré" });
    }

    // 4) Marquer ce code comme utilisé
    await supabaseAdmin
      .from("phone_otp_codes")
      .update({ used: true })
      .eq("id", otpRecord.id);

    // 5) Ici, logiquement tu dois :
    //    - soit trouver un utilisateur Supabase existant lié à ce numéro
    //    - soit créer un utilisateur Supabase si c'est la première fois
    //
    //    ⚠ IMPORTANT :
    //    Supabase ne fournit pas directement une méthode "créer une session" depuis le backend.
    //    Il y a 2 options principales :
    //
    //    Option A : "pseudo-email" basé sur le téléphone (phone-first login)
    //    ---------
    //    const pseudoEmail = `${phone.replace(/[^0-9+]/g, "")}@phone.gregaplay.com`;
    //    - Vérifier s'il existe déjà un user avec cet email
    //    - Sinon, le créer via supabaseAdmin.auth.admin.createUser(...)
    //    - Puis côté frontend, faire un login par mot de passe ou par un one-time token envoyé.
    //
    //    Option B : ton propre système de session (JWT maison dans un cookie)
    //    ---------
    //    - Tu crées ton propre JWT (signé avec un secret backend)
    //    - Tu le renvoies dans un cookie HTTPOnly
    //    - Et ton frontend ne dépend plus de Supabase Auth pour ce type de login.
    //
    //    Pour l'instant, on renvoie juste { success: true } pour boucler le flow OTP.

    return res.json({
      success: true,
      message: "Code vérifié avec succès (prochaine étape: lier au compte utilisateur).",
    });
  } catch (err) {
    console.error("Erreur verify-otp-whatsapp:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
