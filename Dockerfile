# Baton: one container serves the web app, the API and the Meta webhook on port 4000.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=4000 BATON_DATA_DIR=/data
VOLUME /data
EXPOSE 4000
CMD ["npm", "start"]
