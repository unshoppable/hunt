# Container of one Hunt remote session. The relay (relay/main.ts, run by a fixed Node 24) owns the session's sockets,
# drives claude-agent-acp, which runs the native Claude Code CLI, and supervises the preview's processes (relay/preview/).
# Claude Code gets a headless browser through Playwright's MCP server.
# Repositories get the Node and npm versions they pin through Volta. `hunt-ctl install` builds the image on the VM as
# hunt-agent:<bundle hash>, with the bundle (Hunt's remote/ folder) as the build context:
#
#   docker build -f image/Dockerfile -t hunt-agent:<hash> .
#
# Plain Dockerfile syntax only: the VM's Docker may fall back to the legacy builder.
FROM debian:bookworm-slim

ARG NODE_VERSION=24.18.1
ARG NODE_SHA256=d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0
ARG NPM_VERSION=11.16.0
ARG VOLTA_VERSION=2.0.2
ARG VOLTA_SHA256=6cec054c911fb925b629a09455775af6e95dc0f5694a4c28b63979ab9ef18037
ARG TERRAFORM_VERSION=1.15.8
ARG TERRAFORM_SHA256=d25ce7b6902013ad905db3d2eab0be4cd905887fe88b81a6171b8d5503c31f3d
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG PGDG_KEY_SHA256=0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# The pinned downloads below are x86_64 builds, like the VM.
RUN test "$(dpkg --print-architecture)" = amd64 || { echo "hunt-agent images are built for linux/amd64 only" >&2; exit 1; }; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl g++ git git-lfs jq make procps python3 unzip xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    git lfs install --system; \
    git config --system safe.directory '*'

# psql, pg_dump and pg_restore 18 for the preview's init steps, from the PostgreSQL apt repository (PGDG), whose
# signing key is pinned like the downloads below.
RUN install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSLo /etc/apt/keyrings/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    echo "${PGDG_KEY_SHA256}  /etc/apt/keyrings/pgdg.asc" | sha256sum --check --quiet; \
    echo "deb [signed-by=/etc/apt/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" >/etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-18; \
    rm -rf /var/lib/apt/lists/*

# Same uid and gid as the VM's `hunt` user, which owns the mounted worktree, repository and ~/.claude.
RUN groupadd --gid 2000 agent; \
    useradd --uid 2000 --gid 2000 --create-home --home-dir /home/agent --shell /bin/bash agent

# Node for the relay and the adapter, independent of the Node a repository pins. Its corepack serves `hunt-ctl deps`
# and the agent; the script runs on whatever `node` Volta resolves.
RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum --check --quiet; \
    mkdir -p /opt/hunt/node; \
    tar -xJf /tmp/node.tar.xz -C /opt/hunt/node --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    ln -s /opt/hunt/node/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

RUN curl -fsSLo /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip"; \
    echo "${TERRAFORM_SHA256}  /tmp/terraform.zip" | sha256sum --check --quiet; \
    unzip -q /tmp/terraform.zip terraform -d /usr/local/bin; \
    rm /tmp/terraform.zip

# gh for pull requests and CI runs. git and Git LFS take the same GH_TOKEN (the user's GitHub token Hunt passes in, if
# any) through gh's credential helper; the empty entry drops helpers configured before it.
RUN curl -fsSLo /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum --check --quiet; \
    tar -xzf /tmp/gh.tar.gz -C /usr/local/bin --strip-components=2 --no-same-owner "gh_${GH_VERSION}_linux_amd64/bin/gh"; \
    rm /tmp/gh.tar.gz; \
    git config --system credential.https://github.com.helper ''; \
    git config --system --add credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'; \
    git config --system push.autoSetupRemote true

# Volta's shims come first on PATH, so `node` and `npm` follow a repository's `volta` pins and default to the versions
# installed here; profile.d puts them back after /etc/profile resets PATH in login shells, which Claude Code's shell
# snapshot uses. The agent owns VOLTA_HOME so that Volta can fetch other pinned versions at runtime.
ENV VOLTA_HOME=/opt/volta
RUN curl -fsSLo /tmp/volta.tar.gz "https://github.com/volta-cli/volta/releases/download/v${VOLTA_VERSION}/volta-${VOLTA_VERSION}-linux.tar.gz"; \
    echo "${VOLTA_SHA256}  /tmp/volta.tar.gz" | sha256sum --check --quiet; \
    mkdir -p /opt/volta/bin; \
    tar -xzf /tmp/volta.tar.gz -C /opt/volta/bin --no-same-owner; \
    rm /tmp/volta.tar.gz; \
    /opt/volta/bin/volta install "node@${NODE_VERSION}" "npm@${NPM_VERSION}"; \
    chown -R agent:agent /opt/volta; \
    echo 'export PATH="/opt/volta/bin:${PATH}"' > /etc/profile.d/volta.sh

# claude-agent-acp in the version Hunt's package-lock.json pins. The Claude Agent SDK brings the native Claude Code CLI
# as the optional dependency for this platform; without it the adapter cannot run, so the build fails.
COPY image/acp-version /opt/hunt/acp-version
RUN export PATH="/opt/hunt/node/bin:${PATH}"; \
    npm install --prefix /opt/hunt/acp --save-exact --omit=dev --no-audit --no-fund --no-update-notifier \
        "@agentclientprotocol/claude-agent-acp@$(tr -d '[:space:]' < /opt/hunt/acp-version)"; \
    rm -rf /root/.npm; \
    cli=/opt/hunt/acp/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude; \
    test -x "${cli}" || { echo "${cli} is missing: npm did not install the native Claude Code CLI" >&2; exit 1; }; \
    ln -s "${cli}" /usr/local/bin/claude

# Playwright's MCP server for the agent's browser checks of the preview, in the versions
# image/playwright/package-lock.json pins, with Chrome for Testing and the system libraries it needs. The browser lies
# in a root-owned folder of its own, so a repository's own Playwright never mixes its browsers in; the relay offers the
# server to Claude Code as listed in /opt/hunt/mcp-servers.json.
COPY image/playwright/package.json image/playwright/package-lock.json /opt/hunt/playwright/
RUN export PATH="/opt/hunt/node/bin:${PATH}" PLAYWRIGHT_BROWSERS_PATH=/opt/hunt/ms-playwright; \
    npm ci --prefix /opt/hunt/playwright --omit=dev --no-audit --no-fund --no-update-notifier; \
    node /opt/hunt/playwright/node_modules/@playwright/mcp/cli.js install-browser --with-deps --no-shell chromium; \
    rm -rf /root/.npm /var/lib/apt/lists/*
COPY image/mcp-servers.json /opt/hunt/mcp-servers.json

COPY relay/ /opt/hunt/relay/

# `hunt-preview` gives the agent the state of the session's preview, restarts of its processes and their logs.
RUN printf '#!/bin/sh\nexec /opt/hunt/node/bin/node /opt/hunt/relay/preview/cli.ts "$@"\n' >/usr/local/bin/hunt-preview; \
    chmod 0755 /usr/local/bin/hunt-preview

ENV HOME=/home/agent \
    SHELL=/bin/bash \
    PATH=/opt/volta/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    HUNT_CONFIG=/home/agent/.claude/hunt-session.json \
    HUNT_SOCKET_DIR=/run/hunt/socket \
    HUNT_ADAPTER=/opt/hunt/acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js \
    HUNT_MCP_SERVERS=/opt/hunt/mcp-servers.json \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    GH_NO_UPDATE_NOTIFIER=1 \
    GH_PROMPT_DISABLED=1 \
    GIT_TERMINAL_PROMPT=0

RUN test -f "${HUNT_ADAPTER}"

USER agent
WORKDIR /home/agent
ENTRYPOINT ["/opt/hunt/node/bin/node", "/opt/hunt/relay/main.ts"]
