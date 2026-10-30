FROM node:20-slim

WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# App code
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

# Railway (and most PaaS hosts) inject $PORT; server.js reads process.env.PORT.
CMD ["npm", "start"]
