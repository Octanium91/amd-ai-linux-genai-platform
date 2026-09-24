# AMD AI Linux GenAI Platform — a single image: stable-diffusion.cpp (Vulkan/RADV) + server + web UI.
# No ROCm: all generation runs through Vulkan on the Ryzen AI integrated graphics.

# ---------- stable-diffusion.cpp with the Vulkan backend ----------
FROM debian:trixie AS sdcpp
# Pinned version the platform is tested with (update deliberately: Vulkan video regressions happen)
ARG SD_CPP_REF=88411ef
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates pkg-config libvulkan-dev glslc spirv-headers \
    && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/leejet/stable-diffusion.cpp /src \
 && cd /src && git checkout "${SD_CPP_REF}" && git submodule update --init --recursive
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DSD_VULKAN=ON -DBUILD_SHARED_LIBS=OFF \
 && cmake --build build --config Release -j"$(nproc)"

# ---------- web UI ----------
FROM node:22-trixie-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- server dependencies ----------
FROM node:22-trixie-slim AS srv
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- final image on the same Debian 13 as the host (same Mesa/RADV version) ----------
FROM debian:trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvulkan1 mesa-vulkan-drivers vulkan-tools libgomp1 ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=sdcpp /src/build/bin/ /usr/local/bin/
COPY --from=srv /usr/local/bin/node /usr/local/bin/node
COPY --from=srv /app/server/node_modules /app/server/node_modules
COPY server/package.json /app/server/
COPY server/src /app/server/src
COPY catalog /app/catalog
COPY --from=web /web/dist /app/server/public
ENV NODE_ENV=production DATA_DIR=/data CATALOG_DIR=/app/catalog PORT=7860 \n    HOME=/tmp XDG_CACHE_HOME=/data/state/cache
# The container runs as the host user (see docker-compose.yml); HOME and caches must not need root.
# The Mesa shader cache lives in /data/state/cache, so it moves together with the data directory.
WORKDIR /app/server
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:7860/api/auth/me').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
