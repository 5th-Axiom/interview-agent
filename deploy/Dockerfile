ARG NODE_IMAGE=node:24-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG NEXT_PUBLIC_RELAY_URL
ENV NEXT_PUBLIC_RELAY_URL=${NEXT_PUBLIC_RELAY_URL} NEXT_TELEMETRY_DISABLED=1
RUN npm run build
ENV NODE_ENV=production
USER node
EXPOSE 3100 3101
# Runtime secrets are mounted separately; no environment file is baked into the image.
CMD ["npm", "start"]
