# Étape 1 : partir d’une image Node.js officielle (inclut npm)
FROM node:18-slim

# Étape 2 : installer FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Étape 3 : créer dossier de travail
WORKDIR /app

# Étape 4 : copier les fichiers et installer dépendances
COPY package*.json ./
RUN npm install
COPY . .

# Étape 5 : créer dossier temporaire pour montage vidéo
RUN mkdir -p /app/tmp

# Étape 6 : exposer le port (Railway utilise 3000 par défaut)
EXPOSE 3000

# Étape 7 : lancer le serveur
CMD ["node", "services/server.js"]
