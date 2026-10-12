#!/usr/bin/env bash
# filepath: scaffold.sh
set -euo pipefail

mkdir -p services infra/postgres/init contracts web/src

cat > package.json <<'EOF'
{
  "name": "hotel-guest-reservation",
  "private": true,
  "workspaces": ["services/*", "web"],
  "scripts": {
    "test": "npm test --workspaces --if-present"
  }
}
EOF

cat > .gitignore <<'EOF'
node_modules/
coverage/
.env
dist/
EOF

cat > docker-compose.yml <<'EOF'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./infra/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]
      interval: 5s
      timeout: 5s
      retries: 10

  rabbitmq:
    image: rabbitmq:3-management-alpine
    ports:
      - "5672:5672"
      - "15672:15672"
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

  gateway:
    build: ./services/gateway
    ports:
      - "3000:3000"
    environment:
      PORT: 3000
      GUEST_SERVICE_URL: http://guest:3000
      RESERVATION_SERVICE_URL: http://reservation:3000
      ROOM_RATE_SERVICE_URL: http://room-rate:3000
      BILLING_SERVICE_URL: http://billing:3000
      NOTIFICATION_SERVICE_URL: http://notification:3000
    depends_on:
      - guest
      - reservation
      - room-rate
      - billing
      - notification

  guest:
    build: ./services/guest
    ports:
      - "3001:3000"
    environment:
      PORT: 3000
      DATABASE_URL: "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/guest_db"
      RABBITMQ_URL: amqp://rabbitmq:5672
    depends_on:
      postgres:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy

  reservation:
    build: ./services/reservation
    ports:
      - "3002:3000"
    environment:
      PORT: 3000
      DATABASE_URL: "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/reservation_db"
      RABBITMQ_URL: amqp://rabbitmq:5672
    depends_on:
      postgres:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy

  room-rate:
    build: ./services/room-rate
    ports:
      - "3003:3000"
    environment:
      PORT: 3000
      DATABASE_URL: "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/room_rate_db"
      RABBITMQ_URL: amqp://rabbitmq:5672
    depends_on:
      postgres:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy

  billing:
    build: ./services/billing
    ports:
      - "3004:3000"
    environment:
      PORT: 3000
      DATABASE_URL: "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/payment_db"
      RABBITMQ_URL: amqp://rabbitmq:5672
    depends_on:
      postgres:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy

  notification:
    build: ./services/notification
    ports:
      - "3005:3000"
    environment:
      PORT: 3000
      DATABASE_URL: "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/notification_db"
      RABBITMQ_URL: amqp://rabbitmq:5672
    depends_on:
      postgres:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy

volumes:
  postgres_data:
EOF

cat > infra/postgres/init/01-create-databases.sql <<'EOF'
CREATE DATABASE guest_db;
CREATE DATABASE reservation_db;
CREATE DATABASE room_rate_db;
CREATE DATABASE payment_db;
CREATE DATABASE notification_db;
EOF

for service in gateway guest reservation room-rate billing notification; do
  mkdir -p "services/$service/tests"

  cat > "services/$service/package.json" <<EOF
{
  "name": "${service}-service",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "test": "node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --runInBand"
  },
  "dependencies": {
    "express": "^5.1.0",
    "pg": "^8.16.0"
  },
  "devDependencies": {
    "jest": "^30.0.0",
    "supertest": "^7.1.1"
  }
}
EOF

  cat > "services/$service/app.js" <<'EOF'
import express from 'express';

export const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
EOF

  cat > "services/$service/server.js" <<'EOF'
import { app } from './app.js';

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Service listening on port ${port}`);
});
EOF

  cat > "services/$service/jest.config.js" <<'EOF'
export default {
  testEnvironment: 'node',
  transform: {}
};
EOF

  cat > "services/$service/tests/health.test.js" <<'EOF'
import request from 'supertest';
import { app } from '../app.js';

describe('GET /health', () => {
  it('returns the service health status', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
EOF

  cat > "services/$service/Dockerfile" <<'EOF'
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY app.js server.js ./
EXPOSE 3000
CMD ["npm", "start"]
EOF
done

cat > web/package.json <<'EOF'
{
  "name": "hotel-web",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "@vitejs/plugin-react": "^4.4.1",
    "vite": "^6.3.5",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {}
}
EOF

cat > web/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hotel</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
EOF

cat > web/src/main.jsx <<'EOF'
import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <main><h1>Hotel Guest and Reservation</h1></main>;
}

createRoot(document.getElementById('root')).render(<App />);
EOF

cat > contracts/README.md <<'EOF'
# Service contracts

Document REST APIs and RabbitMQ event schemas here. Reservation confirmation
events use the `ReservationConfirmed` event name.
EOF

cat > README.md <<'EOF'
# Hotel Guest and Reservation

## Run

- Start services and infrastructure: `docker compose up --build`
- Install workspace dependencies: `npm install`
- Run service tests: `npm test`
- Start the React development server: `npm run dev --workspace web`

The gateway is available at http://localhost:3000. RabbitMQ management is at
http://localhost:15672 (default credentials: `guest` / `guest`).
EOF