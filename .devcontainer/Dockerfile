ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# Keep both image users' global tool directories on PATH for non-interactive commands.
ENV PATH="/root/.local/share/pnpm/bin:/home/node/.local/share/pnpm/bin:$PATH"
# Install the same native pnpm release that packageManager declares.
COPY --from=ghcr.io/pnpm/pnpm:12.9.1 /opt/pnpm /opt/pnpm
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        ca-certificates \
        curl \
        file \
        git \
        iproute2 \
        jq \
        openssh-client \
        procps \
        python-is-python3 \
        python3 \
        ripgrep \
        unzip \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system init.defaultBranch main \
    && for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/pnpm" "/usr/local/bin/$bin"; done \
    && install -d /pnpm/store/root /root/.local/share/pnpm \
    && install -d -o node -g node /pnpm/store/node /home/node/.local/share/pnpm \
    && pnpm config set store-dir /pnpm/store/root --global \
    && su -s /bin/sh node -c 'pnpm config set store-dir /pnpm/store/node --global'

RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*
