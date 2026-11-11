# MY FOOD API for the central server: the same Hono application as production (apps/api), bundled
# for Node. Built on the server from the repository checkout:
#   docker build -f migration-package/docker/api.Dockerfile -t myfood-api:<commit> .
FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && node scripts/cloudflare/stamp-schema-version.mjs \
 && pnpm exec esbuild apps/api/src/main.ts --bundle --platform=node --target=node24 --format=esm \
      --outfile=/out/main.mjs \
      "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /out/main.mjs ./main.mjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "main.mjs"]
