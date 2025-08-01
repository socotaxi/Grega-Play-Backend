const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const processVideo = require('./processVideo');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = 4000; // <-- 🚨 Changement ici

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ✅ Route de test
app.get('/', (req, res) => {
  res.send('🚀 Backend Grega Play opérationnel');
});

// ✅ Récupérer les vidéos
app.get('/api/videos', async (req, res) => {
  const { eventId } = req.query;
  if (!eventId) return res.status(400).json({ error: 'eventId requis.' });

  try {
    const { data, error } = await supabase
      .from('videos')
      .select('*')
      .eq('event_id', eventId);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Erreur récupération vidéos:', err);
    res.status(500).json({ error: 'Erreur chargement vidéos.' });
  }
});

// ✅ Upload avec buffer (mémoire)
const upload = multer({ storage: multer.memoryStorage() }); // <-- 🚨 Correction ici

app.post('/api/videos/upload', upload.single('file'), async (req, res) => {
  const { eventId, participantName } = req.body;
  const file = req.file;

  if (!eventId || !participantName || !file) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    const filePath = `submissions/${eventId}/${Date.now()}-${file.originalname}`;

    const { error: uploadError } = await supabase.storage
  .from('videos') // ✅ bon bucket
  .upload(`submissions/${eventId}/${Date.now()}-${file.originalname}`, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  });

    if (uploadError) throw uploadError;

    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${filePath}`;

    const { data: insertData, error: insertError } = await supabase
      .from('videos')
      .insert([
        {
          event_id: eventId,
          participant_name: participantName,
          storage_path: filePath,
          video_url: publicUrl,
        },
      ])
      .select();

    if (insertError) throw insertError;

    res.status(200).json(insertData[0]);
  } catch (err) {
    console.error('Erreur upload vidéo:', err.message || err);
    res.status(500).json({ error: "Erreur lors de l'upload de la vidéo" });
  }
});

app.post('/api/videos/process', async (req, res) => {
  const { eventId } = req.query;
  if (!eventId) return res.status(400).json({ error: 'eventId manquant.' });

  try {
    const finalVideoUrl = await processVideo(eventId);
    return res.json({ success: true, finalVideoUrl });
  } catch (error) {
    console.error('❌ Erreur génération vidéo :', error);
    return res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend Grega Play en écoute sur http://localhost:${PORT}`);
});
