# Hotel Management System: Guest and Reservation Subsystem

Microservice prototype for Software Design and Architecture. Node + Express + Postgres + RabbitMQ backend, React (Vite) frontend.

## Architecture

```
React (web, :5173) -> API Gateway (:3010) -> Reservation Service (saga)
                                          -> Guest Service
                                          -> Room and Rate Service
                                          -> Billing Service (stub payment gateway)
Reservation / Billing --events--> RabbitMQ --> Notification Service --SMTP--> Mailpit (or a real mail server)
```

The system manages a single hotel. Every hold is assigned to a concrete room, so a
room's reservations and maintenance windows can be checked against each other.

Booking saga: check availability -> hold a specific room (10 min) -> get-or-create guest -> authorize the 30% deposit -> save reservation -> confirm hold -> publish `ReservationConfirmed`. If the deposit is declined, the hold is released and the API returns 402. A broker outage after the booking is saved does not undo it.

| Service | Host port | Database |
|---|---|---|
| gateway | 3010 (container 3000) | none |
| guest | 127.0.0.1:3001 | guest_db |
| reservation | 127.0.0.1:3002 | reservation_db |
| room-rate | 127.0.0.1:3003 | room_rate_db |
| billing | 127.0.0.1:3004 | payment_db |
| notification | 127.0.0.1:3005 | notification_db |
| mailpit | UI 127.0.0.1:8025, SMTP 1025 | none |
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

# 3. Start the backend (an empty database is filled with sample data automatically:
#    Standard and Deluxe room types with photos, and rooms 101-103 and 201-202)
docker compose up -d --build
docker compose ps          # every service should be "running"

# 4. Start the web app
cd web
npm install
npm run dev                # http://localhost:5173
```

To add the sample room types, photos and rooms to a database that already has
data, run `node seed.js` in `services/room-rate` with
`DATABASE_URL=postgres://postgres:postgres@localhost:55432/room_rate_db`.

Quick check: `curl http://localhost:3010/health` should return `{"status":"ok"}`.

## Authentication (dev only)

The gateway validates JWTs and enforces roles (`guest`, `agent`, `manager`). Guest registration goes through `POST /auth/register`; sign-in uses `POST /login {"username","password"}`. Registration does not verify email ownership. A person who knows the email on a booking-only profile can set its initial password; production deployments should require a verified email or one-time claim code before enabling registration.

The legacy role-based `POST /login {"role":"agent"}` path is only available when `ALLOW_DEV_LOGIN=true`. It defaults to `false` in Docker Compose; enable it only for a local demo by putting `ALLOW_DEV_LOGIN=true` in the root `.env` and recreating the gateway (`docker compose up -d --force-recreate gateway`). Tests that use the role-only login set the flag explicitly. Demo staff accounts are available when `NODE_ENV` is not `production` (or when dev login is enabled):

| Username | Password | Role |
|---|---|---|
| reception | reception123 | agent |
| agent | agent123 | agent |
| manager | manager123 | manager |

Environment variables you may want to set:

| Variable | Purpose |
|---|---|
| `ALLOW_DEV_LOGIN` | Enables the role-based dev login when set to `true` |
| `USERS_JSON` | Optional JSON array of `{ username, role, passwordHash }` records for credential login |
| `VITE_DEV_ROLE_SWITCH` | Enables the dev-only role selector in the web app when set to `true` |
| `INTERNAL_TOKEN` | Shared secret every service requires on internal calls (Compose sets a dev default; change it outside development) |
| `CANCELLATION_POLICY` | `full`, `partial`, or `none` reservation cancellation policy |
| `NOTIFICATION_CHANNEL` | Default notification channel for reservation messages (`email` or `sms`); payment confirmations always use email |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Outgoing mail server (defaults to Mailpit) |
| `HOTEL_CURRENCY` | Currency for new room types (default `USD`) |
| `HOTEL_TIMEZONE` | Hotel time zone used for "today", check-in and check-out (default `Asia/Bangkok`) |
| `PAYMENT_MODE` | Billing demo mode (`decline` forces a declined deposit) |
| `VITE_API_BASE_URL` | Optional override for the gateway URL used by the web app |

## Role permissions

`GET /availability`, `GET /room-types`, guest registration, and login are public.
Room photos (`GET /room-types/{id}/photos/{photoId}`) are public too.
Internal service endpoints (`/holds`, `/deposits`, `/refunds`, `/settlements`,
`/payments/reservations/*`, `/reservations/{no}/payment-approved`) are never routed by the gateway.
The gateway applies the following permissions to authenticated routes:

| Route group | Guest | Agent | Manager |
|---|---|---|---|
| `GET /reservations` | Own reservations only; the gateway forces the guest filter | List/filter reservations | List/filter reservations |
| `POST /reservations`, `GET /reservations/{no}` | Create and view own reservations; booking email must match the signed-in account | All reservations | All reservations |
| `PUT/DELETE /reservations/{no}` | Own reservations, only while `pending` | Until check-in | Until check-in |
| `POST /reservations/{no}/check-in`, `/check-out` | Forbidden | Allowed | Allowed |
| Reservation payment summary and cancellation quote | Own reservation only | All reservations | All reservations |
| `POST/GET /payments/proofs`, `GET /payments/proofs/{id}/file` | Upload and view own proofs/files | View all proofs/files | View all proofs/files |
| `PUT /payments/proofs/{id}/review` | Forbidden | Approve or reject | Approve or reject |
| `POST /guests/get-or-create` | Create or retrieve a profile | Create or retrieve | Create or retrieve |
| Guest profile read/update and `GET /guests/search` | Own profile only; email is immutable | Guest records | Guest records |
| `GET /guests/{id}/export` | Forbidden | Export guest records | Export guest records |
| `DELETE /guests/{id}` | Forbidden | Forbidden | Delete guest records without current or upcoming stays |
| `GET /rooms`, `GET /rooms/availability` | Forbidden | View rooms (API) | View rooms |
| `GET /payments/transactions` | Forbidden | View card transactions | View card transactions |
| `POST/PATCH/DELETE /rooms...`, `PUT/DELETE /rooms/{id}/maintenance`, `POST/PATCH/DELETE /room-types...` including photos | Forbidden | Forbidden | Manage rooms, room types, prices and photos |
| Cancel with `waiveFee=true` | Forbidden | Forbidden | Allowed |

Ownership is checked against the authenticated guest ID. User-supplied guest
filters cannot expand a guest's reservation list.

Guests can update their name, phone, address, passport or ID number, and
preferences from My profile. The account email is read-only. Reservation
searches offer database-backed room types; availability is filtered by stay
dates, guest count, and an optional room type.

## Payments

Guests upload proofs with `POST /payments/proofs`, including the reservation
number, amount, currency, and a multipart file. The reservation must belong to
the authenticated guest. Supported files are PNG, JPEG, and PDF, limited to
5 MB; both the declared MIME type and file signature must match. New proofs have
`pending` status. Agents and managers can approve or reject pending proofs;
rejections require a note. The guest can list their proofs and download their
own files. A proof must match the reservation currency, the reservation must not
be cancelled, and the amount cannot exceed the outstanding balance (total minus
deposit, approved and pending proofs). Approval re-checks the balance and is
refused for cancelled reservations. Approved proof amounts are reflected in the
reservation payment summary as a lower `balanceDue`.

Every payment has a traceable number: uploaded proofs are `PMT-000001`, card
deposits, refunds and front-desk payments are `TXN-000001`. Staff can search
proofs by booking or payment number. Each proof records who reviewed it (and
whether front desk or manager) and when; the proof file opens inside the page
as often as needed.

When the front desk or a manager approves a proof, the guest receives a payment
confirmation email with the stay details, amount paid to date and remaining
balance. Rejections email the reason. Notifications are best-effort; an outage
does not undo or fail the review.

## Reservations

Lifecycle: **pending** (booked, 30% deposit charged) → **confirmed** (the front
desk or a manager approved a payment) → **checked in** → **checked out**
(shown as *Succeeded*). A booking can be **cancelled** before check-in.

- Every guest staying needs a name and passport or ID number: the person booking
  gives theirs, and each additional guest is listed on the booking. Agents see ID
  numbers masked to the last four characters; managers see them in full.
- Check-in cannot be in the past; a modified check-in cannot move into the past.
- Guests can modify or cancel their own booking only while it is pending. The
  front desk can change the dates (and cancel) until check-in.
- Modifying a stay keeps the same room when it is free and adjusts the deposit to
  30% of the new total (charging or refunding only the difference).
- Check-in needs an approved payment and is possible from the check-in date; the
  time is recorded. Check-out records the time, applies (captures) the deposit,
  counts approved payments, asks the desk to collect any remaining balance
  (recorded as a `TXN` payment), and frees the room's remaining nights after an
  early departure.
- Clicking a booking ID shows staff every detail: guests and IDs, dates, room,
  total, deposit, approved and desk payments, balance, payment proofs (with
  reviewer and date) and card transactions.
- Guests are emailed when a booking is received, changed, confirmed by payment,
  checked in (welcome), checked out (final bill) and cancelled.

## Room management (manager)

Room management covers the one hotel the system runs:

- **Photos**: each room type can have any number of photos (JPEG, PNG or WebP up to
  8 MB each). Guests see them in a gallery on each room card when searching.
- **Room types and prices**: create a room type with its maximum guests and
  nightly price, edit it later (new prices apply to new bookings), or delete it
  when no rooms or bookings use it.
- **Rooms**: add a room with an existing room type or create a new type in the same
  step; rename a room or change its type (not while it has upcoming stays); delete
  a room without upcoming stays.
- **Status**: a room is either `available` or under `maintenance` for a period
  (`from` up to the day it is back in service). Maintenance is refused when any
  reservation on that room overlaps the period. Rooms under maintenance are not
  offered for those dates, and the room returns to `available` automatically when
  the period ends.

## Email

Docker Compose sends all email to Mailpit; open http://localhost:8025 to read it.
To deliver real email, set these in the root `.env` and recreate notification
(`docker compose up -d --force-recreate notification`):

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=you@gmail.com
SMTP_PASS=<app password>
MAIL_FROM="StayDesk Hotel <you@gmail.com>"
```

Every notification attempt is stored in `notification_db.notifications`.

## Design patterns

| Pattern | Where | What it buys us |
|---|---|---|
| Chain of Responsibility | `services/gateway/auth-chain.js` | Authenticate → authorize → route; security rules change without touching proxying |
| Facade | API gateway; `web/src/api.js`; `services/reservation/service-clients.js` | One entry point for the UI; one client per remote service |
| Decorator | `services/reservation/http-client.js` | Internal token, timeouts and read retries added around any HTTP call |
| Mediator, Template Method, Command | `services/reservation/saga.js` | Reservation orchestrates the booking saga; steps execute and compensate |
| State | `services/reservation/reservation-state.js`, `services/room-rate/hold-state.js` | Lifecycle rules for bookings and room holds in one place |
| Memento | `services/reservation/memento.js` | Exact undo when cancel or check-out fails half-way |
| Iterator | `services/reservation/refund-plan.js` | Walks payments to plan a refund before any money moves |
| Observer | `services/reservation/events.js`, RabbitMQ consumers, `subscribeSession` in the UI | Domain code announces events; subscribers react |
| Singleton | `getBroker()` in `events.js`; one `pg` pool per service | One broker connection per process instead of one per message |
| Strategy | `services/reservation/cancellation-policy.js` | Cancellation rules swappable by configuration |
| Adapter, Factory Method | `services/billing/payment-gateway.js`, `create*` factories | Payment provider behind a port; objects built by configuration |
| Abstract Factory | `services/notification/channels.js` | Each channel (email, SMS) creates its own message and sender |
| Builder | `services/guest/guest-builder.js` | Validated guest profiles from many optional fields |

Reservation and billing publish events through a transactional outbox: events
are stored in the service's database first and delivered when RabbitMQ is
reachable, so a broker outage never loses a confirmation email.

## Backups

`./scripts/backup.sh` dumps each service database separately into `backups/`
(keeps the 14 newest per database). Schedule it with cron; restore one service
with `docker compose exec -T postgres psql -U postgres -d <db> < backups/<file>.sql`.

## Day-to-day commands

| Task | Command |
|---|---|
| Rebuild after changing a service | `docker compose up -d --build <service>` |
| Apply compose env changes | `docker compose up -d --force-recreate <service>` |
| Service logs | `docker compose logs --since 5m <service>` |
| Open a database | `docker compose exec postgres psql -U postgres -d <db_name>` |
| Reset everything (deletes data) | `docker compose down -v`, then `docker compose up -d` (sample data is added automatically) |
| Web app changes | nothing, Vite hot-reloads |

## Tests

Each service has Jest + Supertest tests; `web/` uses Vitest + React Testing Library.

```bash
npm test --workspace room-rate-service     # package names are in each services/*/package.json
cd web && npm test
```

The guest, reservation, room-rate and billing suites use their own databases
(`guest_test`, `reservation_test`, `room_rate_test`, `payment_test`), which are
created automatically. They refuse to run against a database whose name does
not end in `_test`, so they cannot wipe development data.

Notes:
- `nock` is pinned to v13 (v14 needs Node 22).
- ESM mode: import `jest` with `import { jest } from '@jest/globals'`.
- After adding a dependency to a service, rebuild its container.

## Demo scenarios

Use fresh dates each time, because a confirmed booking uses up a room.

1. **Guest registration and booking.** Register a guest with an email and password, sign in, and book. Expect "Booking confirmed" with the assigned room and a confirmation email in Mailpit (http://localhost:8025).
2. **Guest payment proof.** As the guest, upload a PNG, JPEG, or PDF proof (up to 5 MB) for an owned reservation. Confirm it appears as `pending`.
3. **Agent approval.** Sign in as `reception` / `reception123` (or `agent` / `agent123`), approve the proof, and verify the reservation payment summary reports the approved amount and a reduced `balanceDue`. The guest receives a "Payment confirmed" email.
4. **Agent rejection.** Reject a pending proof with a note and confirm the proof is `rejected` with the note recorded.
5. **Manager cancellation waiver.** Sign in as `manager` / `manager123` and cancel a reservation with `waiveFee=true`; confirm the fee is waived.
6. **Guest data isolation.** Sign in as a guest and try to list or view another guest's reservations, payment summary, cancellation quote, proof, or guest profile. The gateway must deny access or return only the signed-in guest's data.
7. **Room maintenance.** As `manager`, open Room management and try to put the booked room under maintenance over the stay dates: it is refused. Choose dates after the stay: it is accepted and those dates disappear from availability for that room.
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

- Billing and the payment gateway are stubs (Adapter).
- SMS is logged only; email is sent through SMTP.
- Cancellation refunds the card deposit only. Balance payments made by uploaded proof are offline and must be refunded by staff.
- Production security and scaling are described in the report as the target design, not implemented.
- Cancellation uses a strategy (`CANCELLATION_POLICY=full|partial|none`). Partial refunds 50% when check-in is at least two days away.

## Troubleshooting

- **`port is already allocated` / `address already in use`:** another project uses the port. Change the host side of the mapping (`"HOST:CONTAINER"`).
- **Gateway unreachable:** `docker compose ps`; if it is `exited`, read `docker compose logs gateway`.
- **401 from the gateway:** `JWT_SECRET` is missing in the gateway container (`docker compose exec gateway printenv JWT_SECRET`).
- **CORS error in the browser:** the gateway only allows `http://localhost:5173` and `http://127.0.0.1:5173`.
- **Empty room list:** the database is not seeded.
- **No emails:** check `docker compose logs notification` and the `notifications` table in `notification_db`.
- **`Cannot find module`:** add the package to that service's `package.json` and rebuild.