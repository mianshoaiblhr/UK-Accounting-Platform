# One Dockerfile, four runtime targets:  --target api | worker | web | migrate
# Runtime images carry the built workspace (simple and robust for V0; slimming via pnpm deploy is a later optimisation).
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# The web build bakes the same-origin API proxy target
ARG API_INTERNAL_URL=http://api.uk-acc-prod.internal:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN pnpm -r build

FROM node:22-slim AS runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
# Security: pick up patched OS packages (the base image lags behind Debian security fixes) and remove npm - the runtime never
# runs it, and its bundled dependencies are a recurring source of image-scan findings. Everything starts with `node` directly.
RUN apt-get update && apt-get -y upgrade && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node

FROM runtime AS api
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS worker
CMD ["node", "apps/worker/dist/main.js"]

FROM runtime AS web
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["node_modules/.bin/next", "start", "-p", "3000"]

# One-off deployment step (see docs/runbooks/migrations.md)
FROM runtime AS migrate
CMD ["bash", "infra/db/migrate.sh"]
