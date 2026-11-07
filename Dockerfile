# Local stdio server: docker build -t billigast-mcp .
#                     docker run -i --rm billigast-mcp
# Published image:    ghcr.io/idoo/billigast-mcp (built by .github/workflows/release.yml).
# The bundle is plain JavaScript: build it once on the runner's own platform, so multi-arch
# images don't run npm under QEMU.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS build
WORKDIR /src
COPY package.json package-lock.json ./
# esbuild ships its binary as an optional dependency; no install scripts are needed.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:stdio

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
LABEL io.modelcontextprotocol.server.name="io.github.idoo/billigast-mcp"
LABEL org.opencontainers.image.source="https://github.com/idoo/billigast-mcp"
LABEL org.opencontainers.image.description="Read-only MCP server comparing Prisjakt and PriceRunner prices (stdio)"
LABEL org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=build /src/dist/billigast-mcp.js /app/billigast-mcp.js
USER node
ENTRYPOINT ["node", "/app/billigast-mcp.js"]
