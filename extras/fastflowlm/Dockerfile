# FastFlowLM in a container: language models on the Ryzen AI NPU (XDNA 2) behind an OpenAI-compatible
# API, for the platform's prompt assistant. The host needs kernel 7.0+ with the amdxdna driver and
# the NPU firmware (see docs/hardware.md); the container brings XRT and FastFlowLM and gets the
# device: --device /dev/accel/accel0 --ulimit memlock=-1.
FROM debian:trixie
ARG FLM_VERSION=1.0.13
# XRT (libxrt2, libxrt-npu2) is in backports; apt takes it as a dependency of the package
RUN echo "deb http://deb.debian.org/debian trixie-backports main" > /etc/apt/sources.list.d/backports.list \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL -o /tmp/fastflowlm.deb "https://github.com/ROCm/FastFlowLM/releases/download/v${FLM_VERSION}/fastflowlm_${FLM_VERSION}_debian13_amd64.deb" \
    && apt-get install -y --no-install-recommends -t trixie-backports /tmp/fastflowlm.deb \
    && rm -rf /tmp/fastflowlm.deb /var/lib/apt/lists/*
# The model the server loads; downloaded on first start into /root/.config/flm (keep it in a volume)
ENV FLM_MODEL=qwen3:4b
EXPOSE 52625
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://127.0.0.1:52625/v1/models > /dev/null || exit 1
CMD ["sh", "-c", "exec flm serve \"$FLM_MODEL\" --host 0.0.0.0 --port 52625 --quiet"]
