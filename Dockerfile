# AMD AI Linux GenAI Platform — two images from one Dockerfile:
#   worker  stable-diffusion.cpp and audio.cpp (Vulkan/RADV) + ffmpeg + the job queue; owns the GPU,
#           updated rarely
#   web     UI + API + auth + model downloads; no GPU, rebuilt and restarted freely
# The worker image contains only server/src/common and server/src/worker (no npm dependencies),
# so UI and API changes leave it byte-identical and Docker does not recreate the running worker.
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

# ---------- audio.cpp with the Vulkan backend (music, sound effects, speech) ----------
FROM debian:trixie AS audiocpp
ARG AUDIOCPP_REF=v0.8.2-audio8-perf-hotfix
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates pkg-config libvulkan-dev glslc spirv-headers \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${AUDIOCPP_REF}" https://github.com/0xShug0/audio.cpp /src
WORKDIR /src
# ggml loads its backends (Vulkan, the CPU variants) from the directory of the executable
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DAUDIOCPP_MODEL_SET=full -DENGINE_ENABLE_CPU_ALL_VARIANTS=ON \
      -DENGINE_ENABLE_VULKAN=ON -DENGINE_ENABLE_OPENMP=ON -DENGINE_BUILD_EXAMPLES=OFF -DENGINE_BUILD_TESTS=OFF -DENGINE_BUILD_WARMBENCH=OFF \
 && cmake --build build --parallel "$(nproc)" --target audiocpp_cli \
 && mkdir -p /out && cp build/bin/audiocpp_cli /out/ && find build -name "*.so*" -exec cp -P {} /out/ \;

# ---------- RIFE frame interpolation (rife-ncnn-vulkan, MIT): only the binary and the v4.6 model ----------
FROM debian:trixie AS rife
ARG RIFE_REF=20221029
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/rife.zip "https://github.com/nihui/rife-ncnn-vulkan/releases/download/${RIFE_REF}/rife-ncnn-vulkan-${RIFE_REF}-ubuntu.zip" \
 && unzip -q /tmp/rife.zip -d /tmp/r && mkdir -p /out \
 && cp /tmp/r/*/rife-ncnn-vulkan /tmp/r/*/LICENSE /out/ && cp -r /tmp/r/*/rife-v4.6 /out/ \
 && rm -rf /tmp/rife.zip /tmp/r

# ---------- web UI build ----------
FROM node:22-trixie-slim AS ui
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- server dependencies (web only) ----------
FROM node:22-trixie-slim AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json server/.npmrc ./
# onnxruntime-node (background removal on the CPU) ships binaries for every platform: keep linux/x64
RUN npm ci --omit=dev --no-audit --no-fund  && find node_modules/onnxruntime-node/bin -mindepth 3 -maxdepth 3 -type d ! -path '*/linux/x64' -exec rm -rf {} +

# ---------- worker: the same Debian 13 as the host (same Mesa/RADV version) ----------
FROM debian:trixie AS worker
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvulkan1 mesa-vulkan-drivers vulkan-tools libgomp1 ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=sdcpp /src/build/bin/ /usr/local/bin/
COPY --from=audiocpp /out/ /opt/audiocpp/
COPY --from=rife /out/ /opt/rife/
RUN echo /opt/audiocpp > /etc/ld.so.conf.d/audiocpp.conf && ldconfig && ln -s /opt/audiocpp/audiocpp_cli /usr/local/bin/audiocpp_cli
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
RUN mkdir -p /app/server && echo '{"type":"module"}' > /app/server/package.json
COPY server/src/common /app/server/src/common
COPY server/src/worker /app/server/src/worker
# The containers run as the host user (see docker-compose.yml): HOME must not need root, and the
# Mesa shader cache lives in /data/state/cache so it moves together with the data directory
ENV NODE_ENV=production DATA_DIR=/data WORKER_PORT=7861 \
    HOME=/tmp XDG_CACHE_HOME=/data/state/cache
WORKDIR /app/server
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=4 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/7861 && printf 'GET /v1/health HTTP/1.0\r\n\r\n' >&3 && head -1 <&3 | grep -q ' 200 '"]
CMD ["node", "src/worker/index.js"]

# ---------- web ----------
FROM node:22-trixie-slim AS web
COPY --from=deps /app/server/node_modules /app/server/node_modules
COPY server/package.json /app/server/
COPY server/src/common /app/server/src/common
COPY server/src/web /app/server/src/web
COPY catalog /app/catalog
COPY --from=ui /web/dist /app/server/public
ENV NODE_ENV=production DATA_DIR=/data CATALOG_DIR=/app/catalog PORT=7860 \
    WORKER_URL=http://worker:7861 HOME=/tmp \
    ORT_DISABLE_TELEMETRY=1
WORKDIR /app/server
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=4 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/7860 && printf 'GET /api/auth/status HTTP/1.0\r\n\r\n' >&3 && head -1 <&3 | grep -q ' 200 '"]
CMD ["node", "src/web/index.js"]
