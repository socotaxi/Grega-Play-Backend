# Utiliser une image Node avec FFmpeg déjà installé
FROM node:20-bullseye

# Installer FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Définir le dossier de travail
WORKDIR /app

# Copier les fichiers package.json et package-lock.json / pnpm-lock.yaml
COPY package*.json ./

# Installer les dépendances
RUN npm install --production

# Copier le reste du code de l’application
COPY . .

# Créer un dossier tmp pour les vidéos si inexistant
RUN mkdir -p /app/tmp

# Exposer le port
EXPOSE 8080

# Lancer le serveur
CMD ["npm", "start"]

# Créer le dossier assets dans l'image Docker
RUN mkdir -p /app/assets

# Copier le dossier assets dans l'image
COPY assets/ /app/assets/
