# Report vs. implementation: what to align

Checked against *HMS_Guest_Reservation_Report 2(1).docx* (Project Progress, Revised).

## 1. Requirements status

| ID | Requirement (short) | Status | Notes |
|---|---|---|---|
| FR-1 | Create/update guest profiles | Done | Name, phone, email, address, passport/ID, preferences, consent. Loyalty tier is stored and searchable, but only settable through the API by a manager; the UI shows no loyalty fields (team decision). |
| FR-2 | Staff search guests and stay history | Done | Guest directory with search by name, email, phone or loyalty number; booking counts → bookings → full details. |
| FR-3 | Search availability by hotel, dates, guests, room type | Done, **except "by hotel"** | The system now manages a single hotel by design, so there is no hotel filter. |
| FR-4 | Create reservation with hold, deposit, confirmation | Done | 10-minute hold of a specific room, 30% deposit, status *pending* until a payment is approved, then *confirmed*. Confirmation email. |
| FR-5 | Modify dates, room type, guests with re-check and re-price | Done | Re-checks availability, keeps the same room when possible, adjusts deposit. Guests can modify only while *pending*; the front desk can change dates until check-in. |
| FR-6 | Cancel, release inventory, apply policy, refund | Done | Policy is configurable (full/partial/none); manager can waive fees. Guests can cancel only while *pending*. |
| FR-7 | Retrieve reservation by confirmation number or guest info | Done, **differently** | The separate "Look up a reservation" panel was removed. Staff find a booking with the register's search box (booking ID, guest name or room) or via the guest directory; clicking the ID opens all details. Guests click their booking in *My bookings*. |
| NFR-1 | Performance | Done | Read-heavy availability in its own service; one reused broker connection; indexes on hot queries. |
| NFR-2 | Horizontal scaling | Designed, not demonstrated | Services are stateless; row locks, advisory locks and `SKIP LOCKED` outbox make several instances safe. Compose publishes fixed host ports, which must be removed before `docker compose up --scale`. |
| NFR-3 | Security | Done for the prototype | JWT at the gateway, role and ownership checks, internal token between services, internal routes not exposed. No HTTPS/TLS and demo staff accounts are hard-coded (prototype). |
| NFR-4 | Privacy: consent, export, deletion, retention | Mostly done | Consent, export, deletion (blocked while a stay is active), masked ID numbers for agents. **Missing: automatic retention/anonymisation policy.** |
| NFR-5 | Backups and reliable messaging | Done | Transactional outbox, durable queues, retry, poison-message handling, consumer restart; `scripts/backup.sh` per-database backups (schedule with cron). |
| NFR-6 | Standard interfaces | Done | REST/JSON APIs (OpenAPI in `contracts/openapi.yaml`), events documented in `contracts/events.md`. |
| NFR-7 | Independent maintenance and deployment | Done | Own folder, `package.json`, Dockerfile, tests, schema migration and database per service. |

## 2. Report sections that are now out of date

1. **1.2 Project Scope** says check-in/check-out, billing and maintenance are out of scope. The system now includes: check-in/check-out with bill settlement, payment proof upload and approval, room and room-type management with photos, and room maintenance. Either widen the scope statement or describe these as extensions.
2. **1.3, FR-3, 3.3 and the class diagram** mention hotels. Remove `Hotel` (single hotel) and the "by hotel" search.
3. **Use case diagram**: add *Approve Payment*, *Check In / Check Out*, *Manage Rooms and Room Types*, *Upload Payment Proof*. "Look Up Reservation" is now served by search and booking details.
4. **2.3.4 Sequence diagrams / Figure 5**: the booking now ends in *pending*; add the payment-approval step that confirms the booking.
5. **4.1 Service Implementation Status**:
   - Billing is no longer "only authorizeDeposit and refund": it also handles proof uploads and reviews, payment numbers (PMT/TXN), deposit capture and desk settlements.
   - Notification is no longer "logs the message": it sends real email over SMTP, handles four event types and keeps a delivery log in its database.
   - Event Bus carries ReservationConfirmed, ReservationModified, ReservationCancelled and PaymentProofReviewed, published through an outbox.
6. **4.2 Deployment** mentions SQLite or Postgres: it is one Postgres server with one database per service (logical isolation). Say so, and note that production would use separate servers.
7. **4.3 Demonstration scenarios**: add "Broker down" (booking succeeds, email delivered later from the outbox) and "Check-out settlement".

## 3. Functions still missing (if you want full alignment)

| Item | Why it matters | Effort |
|---|---|---|
| Data retention / anonymisation job (NFR-4) | The report promises retention policies | Small: a scheduled job that anonymises guests with no stay for N years |
| Hotel filter (FR-3) | Only if you keep multi-hotel wording in the report | Update the report instead (recommended) |
| Manager UI for loyalty tier (FR-1) | Report lists loyalty tier as profile data | Small |
| Auto-cancel unpaid *pending* bookings | Unpaid bookings hold a room forever | Small: scheduled job, e.g. after 24 h |
| Refund of proof payments on cancellation | Only the card deposit is refunded automatically | Medium |
| Real SMS provider | SMS is logged only | Small with a provider account |
| HTTPS/TLS and secrets management (NFR-3) | Production readiness | Deployment work |
