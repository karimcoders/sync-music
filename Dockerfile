# ---- build -----------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY server ./server
COPY apps/speaker-web ./apps/speaker-web
RUN npm install --no-audit --fund=false
RUN npm run build

# ---- runtime ---------------------------------------------------------------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/package-lock.json* ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/public ./server/public
COPY --from=build /src/apps/speaker-web/dist ./web
RUN mkdir -p /data && addgroup -S app && adduser -S app -G app && chown -R app /data /app
USER app
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/dist/index.js"]
