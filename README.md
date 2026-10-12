# Hotel Management System: Guest and Reservation Subsystem

Microservice prototype for Software Design and Architecture. Node + Express + Postgres + RabbitMQ backend, React (Vite) frontend.

## Architecture

```
React (web, :5173) -> API Gateway (:3010) -> Reservation Service (saga)
                                          -> Guest Service
                                          -> Room and Rate Service
                                          -> Billing Service (stub payment gateway)
Reservation Service --ReservationConfirmed--> RabbitMQ --> Notification Service
```

Booking saga: check availability -> hold room (10 min) -> get-or-create guest -> authorize deposit -> save reservation -> confirm hold -> publish `ReservationConfirmed`. If the deposit is declined, the hold is released and the API returns 402.

| Service | Host port | Database |
|---|---|---|
| gateway | 3010 (container 3000) | none |
| guest | 3001 | guest_db |
| reservation | 3002 | reservation_db |
| room-rate | 3003 | room_rate_db |
| billing | 3004 | payment_db |
| notification | 3005 | notification_db |
| postgres | 55432 (container 5432) | one server, one DB per service |
| rabbitmq | 5672, UI 15672 (guest / guest) | none |
| web (Vite) | 5173 | none |

Ports 3010 and 55432 are deliberately non-default to avoid clashing with other local projects.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose)
- Node 20+ (only needed for the web app, seeding and running tests on the host)
- Git

## First-time setup

```bash
git clone <repo-url>
cd <repo>

# 1. Root .env (read automatically by docker compose)
echo "JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" > .env

# 2. Install dependencies for tests and tooling on the host
npm install

# 3. Start the backend
docker compose up -d --build
docker compose ps          # every service should be "running"

# 4. Seed hotels, room types, rooms and rate plans
cd services/room-rate
DATABASE_URL=postgres://postgres:postgres@localhost:55432/room_rate_db node seed.js
cd ../..

# 5. Start the web app
cd web
npm install
npm run dev                # http://localhost:5173
```

Windows PowerShell seed command:

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:55432/room_rate_db"; node seed.js
```

Quick check: `curl http://localhost:3010/health` should return `{"status":"ok"}`.

## Authentication (dev only)

The gateway validates JWTs and enforces roles (`guest`, `agent`, `manager`). There is no real user database, so `POST /login {"role":"agent"}` returns a token for that role. The web app calls it automatically (`web/src/api.js`). `GET /availability` is public.

## Day-to-day commands

| Task | Command |
|---|---|
| Rebuild after changing a service | `docker compose up -d --build <service>` |
| Apply compose env changes | `docker compose up -d --force-recreate <service>` |
| Service logs | `docker compose logs --since 5m <service>` |
| Open a database | `docker compose exec postgres psql -U postgres -d <db_name>` |
| Reset everything (deletes data) | `docker compose down -v`, then redo steps 3-4 |
| Web app changes | nothing, Vite hot-reloads |

## Tests

Each service has Jest + Supertest tests; `web/` uses Vitest + React Testing Library.

```bash
npm test --workspace room-rate-service     # package names are in each services/*/package.json
cd web && npm test
```

**Warning:** the room-rate and reservation test suites run `TRUNCATE` on their real databases (`room_rate_db`, `reservation_db`). Re-seed after running them, or point `DATABASE_URL` at a separate test database.

Notes:
- `nock` is pinned to v13 (v14 needs Node 22).
- ESM mode: import `jest` with `import { jest } from '@jest/globals'`.
- After adding a dependency to a service, rebuild its container.

## Demo scenarios

Use fresh dates each time, because a confirmed booking uses up a room.

1. **Successful booking.** Book in the UI. Expect "Booking confirmed", and an email line in `docker compose logs notification`.
2. **Declined deposit.** Add `PAYMENT_MODE: decline` under `billing.environment` in `docker-compose.yml`, run `docker compose up -d --force-recreate billing`, and book. Expect a "deposit declined" error. Search the same dates: availability is unchanged. Check `select id, status from holds` in `room_rate_db`: the hold is `released`. **Remove the variable and recreate billing afterwards.**
3. **Notification down.** `docker compose stop notification`, then book (still confirmed). In the RabbitMQ UI (http://localhost:15672, Queues) the `ReservationConfirmed` queue shows Ready = 1. Run `docker compose start notification`: the queue drops to 0 and the email is logged.

Also verify cancel (refund row in `payment_db`, room available again) and modify (new dates, recalculated total, 409 when no rooms are free).

## Repository layout

```
contracts/        API and event definitions
infra/postgres/   init scripts that create one database per service
services/         gateway, guest, reservation, room-rate, billing, notification
web/              React app (src/App.jsx, src/api.js)
docker-compose.yml
```

## Known issues and open items

- Deposit shown as 360 USD for a 120 USD booking: check what `web/src/App.jsx` sends as `depositAmount`.
- Modify checks availability before releasing the old hold, so shifting to overlapping dates on a 1-room type returns 409.
- Billing and the payment gateway are stubs; the deposit is not adjusted when a modification changes the price.
- Notification only logs a test email. No templates.
- Production security and scaling are described in the report as the target design, not implemented.

## Troubleshooting

- **`port is already allocated` / `address already in use`:** another project uses the port. Change the host side of the mapping (`"HOST:CONTAINER"`).
- **Gateway unreachable:** `docker compose ps`; if it is `exited`, read `docker compose logs gateway`.
- **401 from the gateway:** `JWT_SECRET` is missing in the gateway container (`docker compose exec gateway printenv JWT_SECRET`).
- **CORS error in the browser:** the gateway only allows `http://localhost:5173` and `http://127.0.0.1:5173`.
- **Empty room list:** the database is not seeded.
- **`Cannot find module`:** add the package to that service's `package.json` and rebuild.