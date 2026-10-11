# L2 沙箱：助理自己的“电脑”。TODO(P1): exec-daemon、Chromium、Xvfb、noVNC
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git ripgrep curl python3 python3-pip nodejs \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["sleep", "infinity"]
