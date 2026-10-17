# StayDesk: Guest & Reservation Microservices
## Presentation content (29 slides)

Each slide has three parts:
- **On the slide**: the text to put on the slide (keep it this short).
- **Show**: the screenshot or code to place on it.
- **Say**: what the presenter explains (speaker notes).

Suggested split for 6 presenters: slides 1–5, 6–10, 11–15, 16–20, 21–25, 26–29 + demo.

---

## Slide 1: Title

**On the slide**
- StayDesk: Guest & Reservation Subsystem
- Microservice architecture with a monolithic web UI
- Software Design and Architecture: team names and IDs

**Show:** Screenshot of the guest "Find a room" screen with the Deluxe and Standard photo cards.

**Say:** "We rebuilt hotel guest and reservation handling as independent services. Today we'll show why we chose microservices, how we applied them correctly, and how design patterns give each service the quality it needs."

---

## Slide 2: The problem we solve

**On the slide**
| Hotel problem | Our answer |
|---|---|
| Double booking | One service owns room inventory; each hold locks a specific room |
| No hold while booking | 10-minute room hold, released automatically |
| Repeated guest data entry | One guest profile reused by every booking |
| Late or missing confirmations | Event-driven emails that survive outages |
| One error stops everything | Failures stay inside one service |
| Slow at peak times | Busy services scale on their own |

**Show:** A simple icon row (calendar, room key, envelope, broken chain), no screenshot.

**Say:** "Every architecture decision we'll show traces back to one of these six problems from our report."

---

## Slide 3: Scope and what the prototype does

**On the slide**
- **Guests:** sign up, search rooms with photos, book for several guests (name + passport each), upload payment proof, modify or cancel while pending
- **Front desk:** bookings register, approve payments, check in / check out, guest directory with stay history
- **Manager:** everything the front desk does, plus rooms, room types, prices, photos and maintenance windows
- Emails for every change: received, confirmed, updated, checked in, final bill, cancelled

**Show:** Three small screenshots side by side: Guest *My bookings*, Front desk *Reservations register*, Manager *Room management*.

**Say:** "One web application serves three roles. Behind it, six services do the work."

---

## Slide 4: Requirements we had to meet

**On the slide**
- **Functional:** FR-1 guest profiles · FR-2 guest search · FR-3 availability · FR-4 book with hold and deposit · FR-5 modify · FR-6 cancel and refund · FR-7 look up
- **Quality (NFR):** Performance · Scalability · Security · Privacy · Reliability · Interoperability · Maintainability

**Show:** The NFR table from the report (Section 2.2), cropped.

**Say:** "The quality requirements, not the features, decided the architecture. Keep these seven in mind; slide 25 checks every one of them."

---

## Slide 5: Why microservices and not a monolith

**On the slide**
| Monolith | Microservices (our choice) |
|---|---|
| One bug can stop reservations | Notification can crash; bookings continue |
| Scale everything together | Scale Room-Rate and Reservation only |
| One shared database | Each service owns its data |
| Redeploy everything for one change | Rebuild one container: `docker compose up -d --build billing` |
| Simple, but tightly coupled | More moving parts, so we manage them with sagas, events and an outbox |

**Show:** Two-column diagram: one big box vs. six small boxes.

**Say:** "We accept extra complexity because fault isolation and independent scaling were the two problems the hotel cared about most."

---

## Slide 6: Architecture overview

**On the slide** (diagram)
```
            React web UI (one app for guest, front desk, manager)
                              │  HTTPS/JSON + JWT
                         API Gateway (:3010)
          ┌──────────┬────────┴─────┬────────────┬─────────────┐
       Guest    Reservation    Room & Rate     Billing      (Notification)
         │      (orchestrator)       │             │               ▲
      guest_db  reservation_db  room_rate_db  payment_db           │
                     │                             │               │
                     └──── events (outbox) ──► RabbitMQ ──► Notification ──► SMTP
                                                               notification_db
```

**Show:** `docker compose ps` screenshot with all 9 containers running (6 services + Postgres + RabbitMQ + Mailpit).

**Say:** "The browser only knows the gateway. Services talk REST when they need an answer now, and events when they only need to announce something."

---

## Slide 7: Decomposition by business capability

**On the slide**
| Service | Owns | Main operations |
|---|---|---|
| API Gateway | nothing (stateless) | login, JWT check, roles, routing |
| Guest | guest profiles, passports, consent | register, search, export, delete |
| Room & Rate | room types, rates, rooms, photos, holds, maintenance | availability, 10-min holds |
| Reservation | bookings, guest lists, payment ledger | create / modify / cancel, check-in/out, saga |
| Billing | deposits, refunds, payment proofs, settlements | authorize, refund, approve, capture |
| Notification | delivery log | email/SMS on events |

**Show:** The `services/` folder tree in VS Code (six folders, each with its own `app.js`, `schema.sql`, `Dockerfile`, `package.json`, `tests/`).

**Say:** "Each service is one business capability with one team owner, one codebase and one database. No service reaches into another's tables."

---

## Slide 8: Database per service

**On the slide**
- 5 databases: `guest_db`, `reservation_db`, `room_rate_db`, `payment_db`, `notification_db`
- Services keep **only IDs** of foreign data (e.g. a reservation stores `guestId`, not the guest's passport)
- Data from several services is combined by **API composition** (the booking-details screen calls Reservation + Guest + Billing)
- Each service creates and migrates its own schema at startup

**Show:**
1. `infra/postgres/init/01-create-databases.sql` (5 `CREATE DATABASE` lines)
2. Screenshot of the staff **Booking details** dialog (guests from Guest, money from Reservation, proofs and TXN numbers from Billing)

**Say:** "Privacy (NFR-4) follows from this: passports live only in the Guest service. When the front desk needs everything about a booking, the UI asks each owner; no service shares a table."

---

## Slide 9: Monolithic UI + API Gateway

**On the slide**
- One React app, one entry point: `http://localhost:3010`
- Gateway responsibilities: authenticate (JWT), authorize (role + ownership), route to the right service
- Internal-only endpoints are never routed: `/holds`, `/deposits`, `/refunds`, `/settlements`, `/payments/reservations/*`, `/reservations/{no}/payment-approved`

**Show:** Code: `serviceForPath()` and `isInternalOnly()` in `services/gateway/auth-chain.js` (top of the file).

**Say:** "The UI is one application, but it never knows where a service lives. The gateway is a Facade over six services. Routes that move money or block rooms are not reachable from outside at all."

---

## Slide 10: Synchronous vs. asynchronous communication

**On the slide**
| Use REST (sync) when… | Use events (async) when… |
|---|---|
| The caller needs the answer now | Nobody needs to wait |
| e.g. "Is a room free?", "Authorize the deposit" | e.g. "Booking received", "Payment confirmed" |
| Failure must stop the action | Failure must **not** stop the action |

Events: `ReservationConfirmed`, `ReservationModified`, `ReservationCancelled`, `PaymentProofReviewed` (durable RabbitMQ queues)

**Show:** RabbitMQ management UI (http://localhost:15672 → Queues) with the four queues.

**Say:** "A booking must not fail because email is slow, so notifications are events. A booking must fail if no room is free, so availability is a REST call."

---

## Slide 11: Security at the edge: Chain of Responsibility

**On the slide**
```
Request → AuthenticateHandler → AuthorizeHandler → RouteHandler → service
            (valid JWT?)         (role + owner?)     (forward + headers)
```
- Guests see only their own bookings, payments and profile (ownership check)
- Only managers manage rooms or waive fees; only staff approve payments or check guests in

**Show:** Code: `buildGatewayChain()` and `AuthorizeHandler.handle()` in `services/gateway/auth-chain.js`.

**Say:** "Each handler does one check and passes the request on. Adding a rule, for example rate limiting, means adding one handler; routing code does not change."

---

## Slide 12: Zero trust inside the system

**On the slide**
- Every service rejects calls without the internal token: `401 Unauthorized`
- Service ports are bound to `127.0.0.1`; only the gateway is public
- Agents see passport numbers masked (`****4321`); managers and the guest see them in full
- Guests never see which staff member approved their payment

**Show:** Terminal screenshot:
```
curl localhost:3003/rooms          → 401
curl localhost:3010/room-types     → 200
```

**Say:** "Even if someone reaches a service directly, it refuses them. Security is enforced at the edge and inside, which is NFR-3."

---

## Slide 13: The booking saga

**On the slide**
| Step | Service | If a later step fails… |
|---|---|---|
| 1. Check availability | Room & Rate | (nothing to undo) |
| 2. Hold a specific room (10 min) | Room & Rate | release the hold |
| 3. Get or create guest | Guest | (kept: reusable profile) |
| 4. Authorize 30% deposit | Billing | refund the deposit |
| 5. Save reservation (pending) | Reservation | delete it |
| 6. Confirm the hold | Room & Rate | (none) |
| 7. Publish `ReservationCreated` | outbox | (never undoes the booking) |

**Show:** Sequence diagram (Figure 5 from the report, updated to end in *pending*).

**Say:** "There is no distributed transaction across five databases. Instead, each step has a compensating action. A declined deposit releases the room automatically. That is our NFR-5 scenario 2."

---

## Slide 14: The saga in code: Command, Template Method, Mediator

**On the slide**
- **Command:** every step is an object with `execute()` and `compensate()`
- **Template Method:** `runSaga()` fixes the algorithm: run steps in order; on error, compensate completed steps in reverse
- **Mediator:** the Reservation service is the orchestrator; Room & Rate, Guest and Billing never call each other

**Show:** Code: all of `services/reservation/saga.js` (≈30 lines), plus one step from `app.js` (`services.rooms.hold` with `compensate`).

**Say:** "Because services don't talk to each other, Billing doesn't know Room & Rate exists. That's why we can change or redeploy either one alone."

---

## Slide 15: Reliable messaging: Transactional Outbox + Observer + Singleton

**On the slide**
```
Reservation logic ──publish──► domainEvents (Observer)
                                   │ subscriber
                                   ▼
                    event_outbox table (same DB)  ──dispatcher──► RabbitMQ
                                                    (retries every 2 s)
```
- **Observer:** domain code only announces events; it doesn't know about RabbitMQ
- **Singleton:** one broker connection per process (before: a new TCP connection for every message)
- **Outbox:** events are saved first; if RabbitMQ is down, nothing is lost
- `FOR UPDATE SKIP LOCKED`, so several instances can dispatch safely (NFR-2)

**Show:** Code: `services/reservation/events.js` (`createEventBus`, `getBroker`, `dispatch`).

**Say:** "Before this refactor, an event published while RabbitMQ was down was simply lost, and the guest never got their email. Now it waits in our own database until the broker is back."

---

## Slide 16: Proof: the broker-down experiment

**On the slide**
1. `docker compose stop rabbitmq`
2. Guest books a room: **201 Created**, status *pending*
3. Outbox row: `attempts = 2`, `last_error = getaddrinfo ENOTFOUND rabbitmq`, not published
4. `docker compose start rabbitmq`
5. Outbox row: **delivered**; email "Booking received" arrives

**Show:** Two screenshots: the `event_outbox` query before and after, plus the Mailpit inbox with the email.

**Say:** "This is fault isolation and reliable messaging in one picture. The core business action never depends on the messaging infrastructure being up."

---

## Slide 17: The consumer side: Notification service

**On the slide**
- Durable queues + manual `ack`: a message is removed only after the email is sent
- Send failed → retry after 5 s · Malformed message or no recipient → dropped, not looped forever
- Every attempt is logged in `notification_db.notifications` (sent / failed / skipped)
- Reconnects automatically; Docker restarts it if RabbitMQ disappears
- **Abstract Factory:** each channel (email, SMS) creates its own message format and sender; adding LINE or WhatsApp means adding one factory

**Show:** Code: `channelFactories` in `services/notification/channels.js`; screenshot of a real "Payment confirmed" email.

**Say:** "Our report's third demo: stop the notification service, book, start it again, and the email still arrives, because the message waited in the queue."

---

## Slide 18: Concurrency and double booking

**On the slide**
- Every hold is assigned to a **specific room**, inside a transaction that locks the room type (`SELECT … FOR UPDATE`)
- Holds expire after 10 minutes; expired holds no longer count
- Maintenance is refused if any reservation on that room overlaps the period
- Test: two simultaneous holds on the last room → exactly one `201`, one `409`

**Show:** Code: the test `allows only one of two concurrent holds on the last room` in `services/room-rate/tests/room-rate.test.js`, plus the "Room is reserved during that period" error in Room management.

**Say:** "Double booking was problem number one. Because one service owns inventory and serialises holds per room type, it cannot happen, and we have a test proving it."

---

## Slide 19: Reservation lifecycle: State pattern

**On the slide**
```
pending ──payment approved──► confirmed ──check in──► checked in ──check out──► checked out
   │                              │
   └──────── cancel ──────────────┴──► cancelled
```
| Action | pending | confirmed | checked in |
|---|---|---|---|
| Guest modifies / cancels | ✅ | ❌ | ❌ |
| Front desk changes dates / cancels | ✅ | ✅ | ❌ |
| Check in | ❌ (unpaid) | ✅ on the stay dates | ❌ |

**Show:** Code: `services/reservation/reservation-state.js` (the `STATES` object) and the one-line use in a handler: `stateOf(current).modify(...)`.

**Say:** "Before the refactor these rules were copy-pasted into five endpoints. Now each state object answers 'may this happen?', so a new rule changes one file."

---

## Slide 20: Payments across services

**On the slide**
- Guest uploads proof → Billing gives it a traceable number **PMT-000001**
- Front desk approves → Billing asks Reservation to confirm the booking **in the same step**; if that call fails, the approval is rolled back (all-or-nothing)
- Card movements get **TXN-000001** numbers: deposit, refund, front-desk settlement
- Balance rules: a proof can't exceed what is still owed; cancelled bookings can't be paid

**Show:** Screenshot of Payments review (Payment no, Booking, Amount, Reviewed by, Reviewed at) + the in-page proof viewer.

**Say:** "Two services must agree: payment approved and booking confirmed. We make the cross-service call inside Billing's transaction, so they never disagree."

---

## Slide 21: Check-out settlement: Memento

**On the slide**
- Check-out: deposit applied → approved payments counted → remaining balance collected at the desk (TXN) → room's later nights released
- Several services are involved, so any step can fail
- **Memento:** save the reservation's fields before changing them; restore them exactly if a later step fails
- Guest receives the final bill by email

**Show:** Screenshot of the final-bill email ("Deposit applied: −90.00 USD … Balance due: 0.00 USD") + code of `saveMemento` / `restoreMemento` in `services/reservation/memento.js`.

**Say:** "Without the memento, a failed refund or settlement could leave a booking half-cancelled or half-checked-out. Now it is either fully done or untouched."

---

## Slide 22: Calling other services safely: Facade + Decorator

**On the slide**
- **Facade** (`service-clients.js`): `rooms.hold()`, `billing.refund()`, `guests.contact()`. URLs and error mapping live in one place
- **Decorator** (`http-client.js`), wrapped around every call:
  - `withInternalToken`: security
  - `withTimeout`: a hung service fails fast (5 s) instead of freezing the saga
  - `withRetry`: retries **reads** on network/5xx errors; never retries writes
- `createServiceHttp = withRetry(withTimeout(withInternalToken(axios)))`

**Show:** Code: `services/reservation/http-client.js` (whole file, ~50 lines).

**Say:** "Each decorator adds one concern without changing the interface, so we can combine or remove them freely. Writes aren't retried because the saga's compensations handle them."

---

## Slide 23: All 16 patterns at a glance

**On the slide**
| Category | Pattern | Where | Quality it improves |
|---|---|---|---|
| Behavioral | Chain of Responsibility | gateway `auth-chain.js` | Security, Maintainability |
| | Command + Template Method | `saga.js` | Reliability |
| | Mediator | Reservation orchestrator | Maintainability (loose coupling) |
| | State | `reservation-state.js`, `hold-state.js` | Correctness, Maintainability |
| | Strategy | `cancellation-policy.js` | Modifiability |
| | Observer | `events.js`, RabbitMQ, UI session | Reliability, Decoupling |
| | Memento | `memento.js` | Reliability |
| | Iterator | `refund-plan.js` | Maintainability |
| Structural | Decorator | `http-client.js` | Availability, Security |
| | Facade | Gateway, `api.js`, `service-clients.js` | Interoperability, Maintainability |
| | Adapter | `payment-gateway.js` | Interoperability |
| Creational | Factory Method | `createPaymentGateway`, `createApp`, … | Testability |
| | Abstract Factory | `channels.js` | Extensibility |
| | Builder | `guest-builder.js` | Data quality, Privacy |
| | Singleton | `getBroker()`, `pg` pool | Performance |

**Show:** This table (it is the summary slide; no screenshot).

**Say:** "We didn't add patterns for decoration. Each one solved a concrete problem. The next two slides show a few in code."

---

## Slide 24: Creational patterns in code

**On the slide**
- **Builder:** `new GuestBuilder(body).build()` validates required identity and normalises optional fields (phone, address, passport, consent)
- **Factory Method:** `createPaymentGateway(mode)` returns an approving or declining gateway; `createCancellationPolicy(name)` returns full / partial / none
- **Abstract Factory:** `channelFactories.email` → `{ createMessage, createSender }`
- **Singleton:** `getBroker()` always returns the same connection

**Show:** Four short code snippets (≤6 lines each) from `guest-builder.js`, `payment-gateway.js`, `channels.js`, `events.js`.

**Say:** "Factories let us switch behaviour by configuration. `PAYMENT_MODE=decline` turns on our declined-deposit demo without changing code."

---

## Slide 25: Behavioral patterns in code

**On the slide**
- **Strategy:** `CANCELLATION_POLICY=partial` refunds 50 % if check-in is ≥2 days away
- **Iterator:** `for (const part of refundPlan(payments, amount))` refunds newest payments first and fails before any money moves if the ledger is inconsistent
- **Adapter:** Billing talks to a payment-gateway *port*; the stub can be replaced by Stripe/Omise without touching Billing logic

**Show:** `cancellation-policy.js` and `refund-plan.js` side by side.

**Say:** "Strategy and Adapter are why our simplified Billing service is not a dead end: a real payment provider is a new adapter, not a rewrite."

---

## Slide 26: Architectural characteristics scorecard

**On the slide**
| NFR | How we meet it | Evidence |
|---|---|---|
| Performance | Read-heavy availability isolated; one reused broker connection; indexes | Availability is one query per search |
| Scalability | Stateless services; DB locks + `SKIP LOCKED` make multiple instances safe | Outbox test; concurrency test |
| Security | JWT + roles + ownership at gateway; internal token; internal routes hidden | `401` direct call; gateway tests |
| Privacy | Passport only in Guest DB; masking for agents; consent, export, delete | Guest directory screenshot |
| Reliability | Saga compensation, outbox, durable queues, memento, retries, restarts, backups | Broker-down demo |
| Interoperability | REST/JSON + documented events + OpenAPI | `contracts/openapi.yaml` |
| Maintainability | Own code, DB, tests, Dockerfile per service; patterns isolate change | 256 automated tests |

**Show:** This table; highlight the Evidence column.

**Say:** "Every row is backed by something you can see running or a test that proves it."

---

## Slide 27: Independent build, test and deploy

**On the slide**
- Each service: own `package.json`, `Dockerfile`, `schema.sql` (migrates itself at startup), `tests/`
- **256 automated tests**: Gateway 47 · Reservation 41 · Room & Rate 34 · Billing 17 · Guest 16 · Notification 15 · Web 86
- Tests run against separate `*_test` databases and refuse to touch real data
- Deploy one service: `docker compose up -d --build reservation`; the others keep running
- Backups per database: `./scripts/backup.sh`

**Show:** Terminal screenshot of the test runs (all green), and one `docker compose up -d --build <service>` showing only one container recreated.

**Say:** "This is NFR-7 in practice: we changed Billing many times in this project without redeploying Guest or Room & Rate."

---

## Slide 28: Live demo plan (5 scenarios)

**On the slide**
1. **Happy path:** guest books with photos → *pending* → uploads proof → front desk approves → *confirmed* + email
2. **Declined deposit:** `PAYMENT_MODE=decline` → 402, room hold released (saga compensation)
3. **Notification down:** stop notification → booking still works → start it → email arrives
4. **Broker down:** stop RabbitMQ → booking works → start it → outbox delivers the email
5. **Stay:** check in → check out with balance collected → final bill email → *Succeeded*

**Show:** Have these open in tabs: web app (guest + front desk in two browsers), Mailpit or Gmail inbox, RabbitMQ UI, a terminal.

**Say:** "Each scenario proves one architectural claim: the saga, fault isolation, and reliable messaging."

---

## Slide 29: Trade-offs and next steps

**On the slide**
**Costs we accepted**
- Eventual consistency between services → handled with sagas, outbox, memento
- More network calls → timeouts, retries, Facade clients
- More infrastructure to run → Docker Compose, health checks, auto-restart

**Next steps**
- HTTPS and a secrets manager; real SMS provider; real payment adapter
- Auto-cancel unpaid pending bookings; data-retention job (NFR-4)
- Run several instances of Reservation and Room & Rate behind the gateway

**Show:** No screenshot; a simple "Thank you / Questions" footer.

**Say:** "Microservices are not free, but every cost has a matching mechanism in our design. Thank you. Questions?"

---

## Screenshot checklist (prepare before the presentation)

| # | Screenshot | How to get it |
|---|---|---|
| 1 | Guest room search with photo cards | Sign in as a guest → + New Reservation → search 2 guests |
| 2 | Front desk register with Check in/Check out/Succeeded column | `reception` / `reception123` |
| 3 | Booking details dialog (staff) | Click a booking ID |
| 4 | Guest directory with booking counts | Guests menu |
| 5 | Payments review table + proof viewer | Payments menu → click a PMT number |
| 6 | Room management: maintenance refused | Set maintenance over a booked period |
| 7 | Emails: Booking received, Payment confirmed, final bill | Gmail or Mailpit |
| 8 | `docker compose ps` | Terminal |
| 9 | RabbitMQ queues | http://localhost:15672 (guest/guest) |
| 10 | `curl` 401 vs 200 | `curl -i localhost:3003/rooms` and `curl -i localhost:3010/room-types` |
| 11 | Outbox before/after broker restart | `docker compose exec postgres psql -U postgres -d reservation_db -c "select queue, attempts, published_at from event_outbox order by id desc limit 3"` |
| 12 | All tests green | `npm test` in each service, `npx vitest run` in `web/` |
