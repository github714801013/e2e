FROM node:24-bookworm-slim

ENV LANG=C.UTF-8 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    E2E_TELEMETRY_DISABLED=1

WORKDIR /app
COPY project/package.json project/package-lock.json ./
COPY project/vendor/ ./vendor/
RUN npm ci --no-audit --no-fund \
    && node node_modules/@e2e-dev/web/dist/bin.js install chromium --with-deps \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node project/e2e.config.ts ./
COPY --chown=node:node project/fixtures/ ./fixtures/
COPY --chown=node:node project/tests/ ./tests/
COPY --chown=node:node project/support/ ./support/
RUN mkdir -p /app/.e2e && chown node:node /app /app/.e2e

USER node
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/e2e/dist/cli/bin.js", "mcp", "--http", "--host", "0.0.0.0", "--port", "3001", "--allow-host", "10.1.14.158:18091,127.0.0.1:3001,localhost:3001", "--allow-origin", "http://10.1.14.158:18091,http://127.0.0.1:3001,http://localhost:3001", "--max-workers", "4", "--max-runs", "2"]
