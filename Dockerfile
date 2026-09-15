FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
COPY agent ./agent
ENV HOST=0.0.0.0
ENV PORT=5000
ENV NODE_OPTIONS=--dns-result-order=ipv4first
EXPOSE 5000
CMD ["node", "src/index.js"]
