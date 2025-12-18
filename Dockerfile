FROM node:20-bullseye

# Dépendances système (FFmpeg)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installer pnpm via Corepack
RUN corepack enable

# Installer dépendances (cache Docker optimisé)
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Copier le code
COPY . .

# Si tu as un dossier assets nécessaire au runtime
# (garde-le seulement si vraiment utilisé)
COPY assets/ /app/assets/

# Railway fournit PORT
ENV NODE_ENV=production
EXPOSE 3000

# IMPORTANT : ton code doit écouter process.env.PORT
CMD ["pnpm", "start"]
