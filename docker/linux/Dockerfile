# The Linux build of FireVoice, made on any computer that runs Docker (scripts/build-linux.mjs drives it).
# Ubuntu 22.04 on purpose: the app links against that system's libraries, so it runs on it and on anything newer.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    CARGO_HOME=/opt/cargo \
    RUSTUP_HOME=/opt/rustup \
    PATH=/opt/cargo/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file ca-certificates git pkg-config xz-utils rpm patchelf \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev libasound2-dev \
      libxcb-xfixes0-dev libxcb-shape0-dev libxcb-render0-dev libx11-dev libxtst-dev libxi-dev \
      libfuse2 desktop-file-utils squashfs-tools python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Node (the app's UI build) and pnpm
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* && npm install -g pnpm@10

# Rust
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

# uv: bundled into the app, and builds the compiled backend's Python environments
RUN pip3 install --no-cache-dir uv

COPY build.sh /usr/local/bin/firevoice-build
RUN chmod +x /usr/local/bin/firevoice-build
WORKDIR /work
ENTRYPOINT ["firevoice-build"]
