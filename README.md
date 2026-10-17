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
| guest | 127.0.0.1:3001 | guest_db |
| reservation | 127.0.0.1:3002 | reservation_db |
| room-rate | 127.0.0.1:3003 | room_rate_db |
| billing | 127.0.0.1:3004 | payment_db |
| notification | 127.0.0.1:3005 | notification_db |
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

The gateway validates JWTs and enforces roles (`guest`, `agent`, `manager`). Guest registration goes through `POST /auth/register`; sign-in uses `POST /login {"username","password"}`. Registration does not verify email ownership. A person who knows the email on a booking-only profile can set its initial password; production deployments should require a verified email or one-time claim code before enabling registration.

The legacy role-based `POST /login {"role":"agent"}` path is only available when `ALLOW_DEV_LOGIN=true`. It defaults to `false` in Docker Compose; enable it only for a local demo by putting `ALLOW_DEV_LOGIN=true` in the root `.env` and recreating the gateway (`docker compose up -d --force-recreate gateway`). Tests that use the role-only login set the flag explicitly. Demo staff accounts are available when `NODE_ENV` is not `production` (or when dev login is enabled):

| Username | Password | Role |
|---|---|---|
| agent | agent123 | agent |
| manager | manager123 | manager |

Environment variables you may want to set:

| Variable | Purpose |
|---|---|
| `ALLOW_DEV_LOGIN` | Enables the role-based dev login when set to `true` |
| `USERS_JSON` | Optional JSON array of `{ username, role, passwordHash }` records for credential login |
| `VITE_DEV_ROLE_SWITCH` | Enables the dev-only role selector in the web app when set to `true` |
| `INTERNAL_TOKEN` | Shared secret required by internal service-to-service calls |
| `CANCELLATION_POLICY` | `full`, `partial`, or `none` reservation cancellation policy |
| `NOTIFICATION_CHANNEL` | Default notification channel for reservation and payment-review messages (`email` or `sms`) |
| `PAYMENT_MODE` | Billing demo mode (`decline` forces a declined deposit) |
| `VITE_API_BASE_URL` | Optional override for the gateway URL used by the web app |

## Role permissions

`GET /availability`, `GET /hotels`, guest registration, and login are public.
The gateway applies the following permissions to authenticated routes:

| Route group | Guest | Agent | Manager |
|---|---|---|---|
| `GET /reservations` | Own reservations only; the gateway forces the guest filter | List/filter reservations | List/filter reservations |
| `POST /reservations`, `GET/PUT/DELETE /reservations/{no}` | Create and manage own reservations only | All reservations | All reservations |
| Reservation payment summary and cancellation quote | Own reservation only | All reservations | All reservations |
| `POST/GET /payments/proofs`, `GET /payments/proofs/{id}/file` | Upload and view own proofs/files | View all proofs/files | View all proofs/files |
| `PUT /payments/proofs/{id}/review` | Forbidden | Approve or reject | Approve or reject |
| `POST /guests/get-or-create` | Create or retrieve a profile; loyalty tier is forced to `none` | Create or retrieve; loyalty tier is forced to `none` | Create or retrieve and set loyalty tier |
| Guest profile read/update and `GET /guests/search` | Own profile only; cannot change loyalty tier | Guest records; cannot change loyalty tier | Guest records and loyalty tier management |
| `GET /guests/{id}/export` | Forbidden | Export guest records | Export guest records |
| `DELETE /guests/{id}` | Forbidden | Forbidden | Delete guest records |
| Cancel with `waiveFee=true` | Forbidden | Forbidden | Allowed |

Ownership is checked against the authenticated guest ID. User-supplied guest
filters cannot expand a guest's reservation list.

## Payments

Guests upload proofs with `POST /payments/proofs`, including the reservation
number, amount, currency, and a multipart file. The reservation must belong to
the authenticated guest. Supported files are PNG, JPEG, and PDF, limited to
5 MB; both the declared MIME type and file signature must match. New proofs have
`pending` status. Agents and managers can approve or reject pending proofs;
rejections require a note. The guest can list their proofs and download their
own files. Approved proof amounts are reflected in the reservation payment
summary as a lower `balanceDue`. Approval and rejection notifications use
`NOTIFICATION_CHANNEL` and are best-effort; a notification outage does not
undo or fail the review.

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

1. **Guest registration and booking.** Register a guest with an email and password, sign in, and book. Expect "Booking confirmed" and a notification line in `docker compose logs notification`.
2. **Guest payment proof.** As the guest, upload a PNG, JPEG, or PDF proof (up to 5 MB) for an owned reservation. Confirm it appears as `pending`.
3. **Agent approval.** Sign in as `agent` / `agent123`, approve the proof, and verify the reservation payment summary reports the approved amount and a reduced `balanceDue`.
4. **Agent rejection.** Reject a pending proof with a note and confirm the proof is `rejected` with the note recorded.
5. **Manager cancellation waiver.** Sign in as `manager` / `manager123` and cancel a reservation with `waiveFee=true`; confirm the fee is waived.
6. **Guest data isolation.** Sign in as a guest and try to list or view another guest's reservations, payment summary, cancellation quote, proof, or guest profile. The gateway must deny access or return only the signed-in guest's data.
7. **Successful booking notification.** Book in the UI and confirm a notification line in `docker compose logs notification`.
8. **Declined deposit.** Add `PAYMENT_MODE: decline` under `billing.environment` in `docker-compose.yml`, run `docker compose up -d --force-recreate billing`, and book. Expect a "deposit declined" error. Search the same dates: availability is unchanged. Check `select id, status from holds` in `room_rate_db`: the hold is `released`. **Remove the variable and recreate billing afterwards.**
9. **Notification down.** `docker compose stop notification`, then book (still confirmed). In the RabbitMQ UI (http://localhost:15672, Queues) the `ReservationConfirmed` queue shows Ready = 1. Run `docker compose start notification`: the queue drops to 0 and the notification is logged.

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

- Billing and the payment gateway are stubs (Adapter); the deposit is not adjusted when a modification changes the price.
- Notification logs a test email or SMS. No template management.
- Production security and scaling are described in the report as the target design, not implemented.
- Cancellation uses a strategy (`CANCELLATION_POLICY=full|partial|none`). Partial refunds 50% when check-in is at least two days away.

## Troubleshooting

- **`port is already allocated` / `address already in use`:** another project uses the port. Change the host side of the mapping (`"HOST:CONTAINER"`).
- **Gateway unreachable:** `docker compose ps`; if it is `exited`, read `docker compose logs gateway`.
- **401 from the gateway:** `JWT_SECRET` is missing in the gateway container (`docker compose exec gateway printenv JWT_SECRET`).
- **CORS error in the browser:** the gateway only allows `http://localhost:5173` and `http://127.0.0.1:5173`.
- **Empty room list:** the database is not seeded.
- **`Cannot find module`:** add the package to that service's `package.json` and rebuild.