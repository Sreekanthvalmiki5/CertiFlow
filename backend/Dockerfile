# One image, three roles (api / worker / whatsapp stand-in), chosen by command.
FROM node:22-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json vitest.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.json

# Test image: full dev dependencies + test sources.
FROM build AS test
COPY tests ./tests
CMD ["npm", "run", "test:docker"]

FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
RUN mkdir -p /data/certificates && chown -R node:node /data /app
USER node
EXPOSE 4000
CMD ["node", "dist/src/server.js"]
