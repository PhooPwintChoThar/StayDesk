FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY app.js server.js db.js schema.sql ./
EXPOSE 3000
CMD ["npm", "start"]
