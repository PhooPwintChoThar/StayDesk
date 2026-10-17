FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY *.js schema.sql ./
COPY sample-photos ./sample-photos
EXPOSE 3000
CMD ["npm", "start"]
