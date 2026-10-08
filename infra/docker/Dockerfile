# One Dockerfile, three runtime targets:  --target api | worker | web
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
ARG API_INTERNAL_URL=http://api.internal:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN pnpm -r build
RUN pnpm --filter @uk/api --prod deploy /out/api \
 && pnpm --filter @uk/worker --prod deploy /out/worker \
 && pnpm --filter @uk/db --prod deploy /out/migrate

FROM base AS api
ENV NODE_ENV=production
COPY --from=build /out/api /app
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /out/worker /app
USER node
CMD ["node", "dist/main.js"]

# One-off task run before each deploy:  node_modules/.bin/prisma migrate deploy
FROM base AS migrate
COPY --from=build /out/migrate /app
CMD ["npx", "prisma", "migrate", "deploy"]

FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone /app
COPY --from=build /app/apps/web/.next/static /app/apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
