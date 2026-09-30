FROM node:lts-alpine

ENV MCP_AGGREGATOR_HOME=/app
ENV MCP_AGGREGATOR_CONFIG=/app/config
ENV MCP_COMPRESS_ROUTER_HOME=/app/state
ENV NODE_USE_SYSTEM_CA=1

# Only the state directory is writable; a root-owned /app keeps the runtime user from replacing the installed tree, since renaming a directory needs write permission on its parent.
RUN install -d "${MCP_AGGREGATOR_CONFIG}" && \
    install -d -o nobody -g nobody "${MCP_COMPRESS_ROUTER_HOME}"

WORKDIR ${MCP_AGGREGATOR_HOME}
COPY package.json package-lock.json ./

# ln without -f, so a dependency shipping a colliding binary fails the build rather than shadowing.
RUN npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error && \
    npm cache clean --force && \
    ln -s "${MCP_AGGREGATOR_HOME}/node_modules/.bin/"* /usr/local/bin/

# CONFIG_REVISION is a cache-bust token derived from build secrets (see build.js).
ARG CONFIG_REVISION

# mcp.json is symlinked so a rebuild always wins; credentials.json is a real file because the
# router rewrites it on every token refresh, and Podman seeds it into an empty named volume once.
RUN --mount=type=secret,id=mcp_json \
    --mount=type=secret,id=mcp_credentials \
    install -D -o nobody -g nobody -m 600 /run/secrets/mcp_json "${MCP_AGGREGATOR_CONFIG}/mcp.json" && \
    install -D -o nobody -g nobody -m 600 /run/secrets/mcp_credentials "${MCP_COMPRESS_ROUTER_HOME}/credentials.json" && \
    ln -sf "${MCP_AGGREGATOR_CONFIG}/mcp.json" "${MCP_COMPRESS_ROUTER_HOME}/mcp.json"

ARG PORT=20000

# Exec-form ENTRYPOINT performs no variable substitution, so the port is baked into a generated
# launcher instead. exec keeps supergateway as PID 1 so signals and init reaping still work.
# --stateful spawns one router per client session and keeps it for the session's lifetime; stateless mode would spawn a
# router, and reconnect every downstream, on each request. Routers are not shared across sessions (see OAuth in README.md).
RUN { \
      echo '#!/bin/sh'; \
      printf 'exec supergateway --stateful'; \
      printf ' --stdio mcp-compress-router --outputTransport streamableHttp'; \
      printf ' --port %s --streamableHttpPath /mcp --healthEndpoint /healthz\n' "${PORT}"; \
    } > /usr/local/bin/entrypoint && \
    chmod 755 /usr/local/bin/entrypoint

EXPOSE ${PORT}

WORKDIR /
USER nobody

ENTRYPOINT ["/usr/local/bin/entrypoint"]
