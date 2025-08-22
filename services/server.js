import express from "express";
import cors from "cors";
import morgan from "morgan";
import processVideo from "./processVideo.js";

const app = express();

// Middleware logging (origine + méthode + URL)
app.use((req, res, next) => {
  console.log(`🌍 Requête reçue: ${req.method} ${req.url} | Origin: ${req.headers.origin}`);
  next();
});

// CORS config (ajoute ton domaine frontend ici)
const allowedOrigins = [
  "https://grega-play-frontend.vercel.app",
  "http://localhost:5173" // utile en dev local
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`❌ Origin non autorisée: ${origin}`);
        callback(new Error("CORS non autorisé"));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Accepte aussi les requêtes OPTIONS (préflight)
app.options("*", cors());

// Pour parser JSON
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.status(200).send("✅ OK");
});

// Upload vidéo (exemple si tu l’as déjà)
app.post("/api/videos/upload", (req, res) => {
  res.status(200).json({ message: "Upload OK (stub)" });
});

// Route process vidéo
app.post("/api/videos/process", async (req, res) => {
  try {
    console.log("🎬 Reçu une requête pour générer la vidéo finale");
    const { eventId } = req.body;

    if (!eventId) {
      return res.status(400).json({ error: "eventId manquant" });
    }

    await processVideo(eventId);
    res.status(200).json({ message: "Vidéo générée avec succès" });
  } catch (error) {
    console.error("❌ Erreur génération vidéo:", error);
    res.status(500).json({ error: "Erreur interne" });
  }
});

// Lancer serveur
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Backend Grega Play en écoute sur le port ${PORT}`);
});
