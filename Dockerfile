# The Anthropic CLI (`ant`), so the owner can sign Claude in with an Anthropic Console account instead of an API key:
#   docker compose exec engine ant --profile beebots auth login --no-browser
FROM golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS ant
ARG ANT_VERSION=v1.35.0
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/anthropics/anthropic-cli/cmd/ant@${ANT_VERSION}

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /app
RUN npm i -g pnpm@10.34.5
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
# The release this image was built from (set by the GitHub release build). "dev" for local builds: no update check.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production REF_DIR=/app/ref SETTINGS_PATH=/data/settings.json LAB_DIR=/data/lab GRAPH_PATH=/data/lab/hive-mind.sqlite
# Anthropic sign-in profiles (ant auth login) live in the data volume, so they survive updates.
ENV ANTHROPIC_CONFIG_DIR=/data/anthropic
WORKDIR /app
# OKX CLI profiles (site = "eea", no keys; keys come from the environment per call) and its 7-day trade log live here.
RUN mkdir -p /home/node/.okx /data && chown -R node:node /home/node /data
COPY --from=ant /out/ant /usr/local/bin/ant
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts/okx-profiles.sh ./scripts/okx-profiles.sh
# The three original portraits: the default art, and the style reference for generated bees.
COPY --chown=node:node dashboard/public/bees ./ref
# Importable strategy skills for the lab (docs/INTELLIGENCE.md). Run it with: docker compose exec engine node dist/tools/lab.js cycle
COPY --chown=node:node skills ./skills
USER node
ENV HOME=/home/node
RUN sh ./scripts/okx-profiles.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
