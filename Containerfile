FROM node:lts-alpine

ARG SUPERGATEWAY_VERSION=3.4.3
ARG MCP_ROUTER_VERSION=1.5.2

ENV MCP_COMPRESS_ROUTER_HOME=/home/mcp/.local/share/mcp-compress-router
ENV MCP_AGGREGATOR_CONFIG=/home/mcp/config
ENV NODE_USE_SYSTEM_CA=1

RUN adduser -D mcp && \
    install -d -o mcp -g mcp "${MCP_COMPRESS_ROUTER_HOME}" "${MCP_AGGREGATOR_CONFIG}"

RUN npm install --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error -g \
    "supergateway@${SUPERGATEWAY_VERSION}" \
    "mcp-compress-router@${MCP_ROUTER_VERSION}"

# CONFIG_REVISION is a cache-bust token derived from build secrets (see build.cjs).
ARG CONFIG_REVISION

# mcp.json is symlinked so a rebuild always wins; credentials.json is a real file because the
# router rewrites it on every token refresh, and Podman seeds it into an empty named volume once.
RUN --mount=type=secret,id=mcp_json \
    --mount=type=secret,id=mcp_credentials \
    install -D -o mcp -g mcp -m 600 /run/secrets/mcp_json "${MCP_AGGREGATOR_CONFIG}/mcp.json" && \
    install -D -o mcp -g mcp -m 600 /run/secrets/mcp_credentials "${MCP_COMPRESS_ROUTER_HOME}/credentials.json" && \
    ln -sf "${MCP_AGGREGATOR_CONFIG}/mcp.json" "${MCP_COMPRESS_ROUTER_HOME}/mcp.json"

ARG PORT=20000

# Exec-form ENTRYPOINT performs no variable substitution, so the port is baked into a generated
# launcher instead. exec keeps supergateway as PID 1 so signals and init reaping still work.
RUN { \
      echo '#!/bin/sh'; \
      printf 'exec supergateway --stateful --sessionTimeout 86400000'; \
      printf ' --stdio mcp-compress-router --outputTransport streamableHttp'; \
      printf ' --port %s --streamableHttpPath /stream\n' "${PORT}"; \
    } > /usr/local/bin/entrypoint && \
    chmod 755 /usr/local/bin/entrypoint

EXPOSE ${PORT}

WORKDIR /home/mcp
USER mcp

ENTRYPOINT ["/usr/local/bin/entrypoint"]
