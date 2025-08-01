# Image Node.js + FFmpeg
FROM jrottenberg/ffmpeg:4.4-ubuntu

# Créer dossier app
WORKDIR /app

# Installer Node.js (v18)
RUN apt-get update && apt-get install -y curl gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs

# Copier et installer les dépendances
COPY package*.json ./
RUN npm install

# Copier le reste de l'app
COPY . .

# Créer dossier temporaire
RUN mkdir -p /app/tmp

# Exposer le port
EXPOSE 3000

# Démarrer le backend
CMD ["node", "services/server.js"]
