// services/uploadMiddleware.js
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Gestion de __dirname en ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dossier où seront stockées les vidéos uploadées
// Ici, on crée un dossier "uploads" à côté de server.js
const UPLOAD_DIR = path.join(__dirname, "uploads");

// S'assurer que le dossier existe
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log("📁 Dossier d'upload créé :", UPLOAD_DIR);
} else {
  console.log("📁 Dossier d'upload existant :", UPLOAD_DIR);
}

// Configuration du stockage Multer
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname || "");
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

// Instance Multer exportée
// ⚠️ Important: on ne met PAS de limite globale ici.
// Les limites sont gérées par les "capabilities" + validation côté frontend,
// avec une exception admin (définie via ADMIN_EMAIL) qui ne doit pas être limitée.
export const upload = multer({
  storage,
});
