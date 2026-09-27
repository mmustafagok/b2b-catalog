# Multi-stage production Dockerfile for CatalogFlow: B2B Order Catalog

FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# Copy source code and build production bundle
COPY . .
RUN npx prisma generate
RUN npm run build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy built artifacts and dependencies
COPY package*.json ./
COPY prisma ./prisma/
COPY scripts ./scripts/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 8080

CMD ["npm", "run", "start:prod"]
