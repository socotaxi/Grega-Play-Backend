# Étape 1 : partir d’une image Node.js officielle (inclut npm)
FROM node:20-slim

# Étape 2 : installer FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Étape 3 : créer dossier de travail
WORKDIR /app

# Étape 4 : copier les fichiers et installer dépendances
COPY package*.json ./
RUN npm install
COPY . .

# ✅ Étape spéciale : s'assurer que le logo est bien présent
RUN mkdir -p /app/assets
COPY assets/logo.png /app/assets/logo.png

# Étape 5 : créer dossier temporaire pour montage vidéo
RUN mkdir -p /app/tmp

# Étape 6 : exposer le port utilisé par Railway
EXPOSE 8080

# Étape 7 : lancer le serveur
CMD ["npm", "start"]

# Étape 8 : fini!