# MY FOOD web app (static) for the central server. Only PUBLIC values are build arguments: the
# Supabase-compatible URL of this deployment and its anon key (the same value every browser gets).
FROM node:24-slim AS build
ARG SUPABASE_URL
ARG SUPABASE_ANON_KEY
WORKDIR /src
RUN corepack enable
COPY . .
RUN test -n "$SUPABASE_URL" && test -n "$SUPABASE_ANON_KEY" \
 && pnpm install --frozen-lockfile \
 && mkdir -p /tmp/webenv \
 && printf 'VITE_SUPABASE_URL=%s\nVITE_SUPABASE_ANON_KEY=%s\nVITE_API_URL=\n' "$SUPABASE_URL" "$SUPABASE_ANON_KEY" > /tmp/webenv/.env \
 && VITE_ENV_DIR=/tmp/webenv pnpm --filter @rp/web exec vite build \
 && mkdir -p apps/web/dist/manual && cp docs/manual/*.pdf docs/manual/*.xlsx apps/web/dist/manual/

FROM caddy:2.10-alpine
ARG SUPABASE_URL
ENV SUPABASE_ORIGIN=${SUPABASE_URL}
# Realtime websocket origin (wss:// for https://, ws:// for a plain-HTTP staging host).
ARG SUPABASE_WS_ORIGIN
ENV SUPABASE_WS_ORIGIN=${SUPABASE_WS_ORIGIN}
COPY --from=build /src/apps/web/dist /srv
COPY migration-package/docker/web.Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
