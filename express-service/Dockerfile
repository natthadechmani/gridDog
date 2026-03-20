FROM node:20-alpine

# Create a non-root user and group
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy application source
COPY index.js ./

# Transfer ownership to the non-root user
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3001

CMD ["node", "index.js"]
