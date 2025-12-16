routes/ : reçoit la requête, valide, appelle un service, renvoie JSON.

services/ : logique métier (premium, vidéo, email, push), parle à Supabase/Stripe/FFmpeg.

assets/ : fichiers statiques (logo, watermark).

tmp/, uploads/ : runtime seulement (doivent être ignorés par Git).