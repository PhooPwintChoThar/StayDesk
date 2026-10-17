import { randomUUID } from "node:crypto";
import express from "express";
import { pool } from "./db.js";
import { HttpError, runSaga } from "./saga.js";
import { createCancellationPolicy } from "./cancellation-policy.js";
import { createServiceHttp } from "./http-client.js";
import { createServiceClients } from "./service-clients.js";
import { stateOf, stayOf } from "./reservation-state.js";
import { restoreMemento, saveMemento } from "./memento.js";
import { refundPlan } from "./refund-plan.js";
import { domainEvents } from "./events.js";

const DEPOSIT_PERCENT = 30;
const isStaff = (role) => role === "agent" || role === "manager";

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validDates(checkIn, checkOut) {
  return validDate(checkIn) && validDate(checkOut) && checkOut > checkIn;
}

function localDate(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function roundMoney(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

function totalPrice(nightlyRate, checkIn, checkOut) {
  const nights =
    (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) /
    86_400_000;
  return roundMoney(Number(nightlyRate) * nights);
}

function depositPrice(amount) {
  return roundMoney((amount * DEPOSIT_PERCENT) / 100);
}

function fail(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function parseGuests(value) {
  if (value == null || value === "") return null;
  const guests = Number(value);
  return Number.isInteger(guests) && guests >= 1 ? guests : undefined;
}

// Details for guests 2..n of a booking: [{ name, idDocument }]. undefined = not sent.
function parseAdditionalGuests(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return { error: true };
  const list = value.map((item) => ({
    name: typeof item?.name === "string" ? item.name.trim() : "",
    idDocument: typeof item?.idDocument === "string" ? item.idDocument.trim() : "",
  }));
  return list.some((item) => !item.name || !item.idDocument) ? { error: true } : list;
}

function guestDetailsError(count) {
  return count > 1
    ? `Enter the name and passport or ID number for each of the ${count} guests.`
    : "Only the guest who books is needed for one guest.";
}

function maskDocument(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length <= 4) return "****";
  return `${"*".repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
}

async function loadAdditionalGuests(db, reservationNo, role) {
  const result = await db.query(
    `SELECT position, full_name AS name, id_document AS "idDocument"
     FROM reservation_guests WHERE reservation_no = $1 ORDER BY position`,
    [reservationNo],
  );
  // Same rule as guest profiles: agents see only the last four characters.
  return result.rows.map((row) =>
    role === "agent" ? { ...row, idDocument: maskDocument(row.idDocument) } : row,
  );
}

async function replaceAdditionalGuests(client, reservationNo, list) {
  await client.query("DELETE FROM reservation_guests WHERE reservation_no = $1", [reservationNo]);
  for (const [index, item] of list.entries()) {
    await client.query(
      `INSERT INTO reservation_guests (id, reservation_no, position, full_name, id_document)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), reservationNo, index + 2, item.name, item.idDocument],
    );
  }
}

async function settledTotal(db, reservationNo) {
  const result = await db.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total
     FROM reservation_payments WHERE reservation_no = $1 AND type = 'settlement'`,
    [reservationNo],
  );
  return Number(result.rows[0].total);
}

function actorFromRequest(req) {
  return {
    id: req.headers["x-user-id"] || null,
    role: req.headers["x-user-role"] || null,
  };
}

function depositHeldValue(reservation) {
  return Number(
    reservation.depositHeld ??
    reservation.deposit_net ??
    reservation.depositAmount ??
    reservation.deposit_amount ??
    0,
  );
}

function currencyValue(reservation) {
  return String(reservation.currency ?? "USD").trim();
}

function quoteFromHours(hoursBeforeCheckIn, heldAmount, overridePercent) {
  const effectivePercent = overridePercent ?? (hoursBeforeCheckIn >= 48 ? 100 : hoursBeforeCheckIn >= 24 ? 50 : 0);
  const refundAmount = Math.round((Number(heldAmount) * effectivePercent) * 100) / 10000;
  const feeAmount = roundMoney(Number(heldAmount) - refundAmount);
  return { refundAmount, feeAmount };
}

const reservationSelect = `
  reservation_no AS "reservationNo", guest_id AS "guestId",
  room_type_id AS "roomTypeId", room_id AS "roomId", room_number AS "roomNumber",
  to_char(check_in, 'YYYY-MM-DD') AS "checkIn",
  to_char(check_out, 'YYYY-MM-DD') AS "checkOut",
  total_amount::float AS "totalAmount",
  deposit_id AS "depositId", deposit_amount::float AS "depositAmount",
  COALESCE(deposit_net, deposit_amount)::float AS "depositHeld",
  TRIM(currency) AS currency, status, guests,
  created_at AS "createdAt", confirmed_at AS "confirmedAt",
  checked_in_at AS "checkedInAt", checked_out_at AS "checkedOutAt"
`;

// Raw row plus calendar dates as text: pg turns DATE columns into JS Dates otherwise.
const rawSelect = `
  *, to_char(check_in, 'YYYY-MM-DD') AS "checkInDate",
  to_char(check_out, 'YYYY-MM-DD') AS "checkOutDate"
`;

async function loadReservation(db, reservationNo) {
  const result = await db.query(
    `SELECT ${reservationSelect},
            cancelled_at AS "cancelledAt", refund_amount::float AS "refundAmount",
            cancellation_fee::float AS "cancellationFee"
     FROM reservations
     WHERE reservation_no = $1`,
    [reservationNo],
  );
  return result.rows[0] || null;
}

async function loadRawReservation(db, reservationNo) {
  const result = await db.query(
    `SELECT ${rawSelect} FROM reservations WHERE reservation_no = $1`,
    [reservationNo],
  );
  return result.rows[0] || null;
}

async function loadPaymentSources(db, reservation) {
  const result = await db.query(
    `SELECT rp.id,
            rp.billing_payment_id AS "billingPaymentId",
            rp.type,
            rp.amount::float AS amount,
            rp.currency,
            rp.created_at AS "createdAt",
            COALESCE((
              SELECT SUM(r.amount)::float
              FROM reservation_payments r
              WHERE r.reservation_no = rp.reservation_no
                AND r.type IN ('refund', 'cancellation_refund')
                AND r.deposit_ref = rp.billing_payment_id
            ), 0)::float AS refunded
     FROM reservation_payments rp
     WHERE rp.reservation_no = $1
       AND rp.type IN ('deposit', 'topup')
     ORDER BY rp.created_at DESC, rp.id DESC`,
    [reservation.reservation_no],
  );
  if (result.rowCount === 0 && reservation.deposit_id) {
    return [{
      id: `legacy-${reservation.deposit_id}`,
      billingPaymentId: reservation.deposit_id,
      type: 'deposit',
      amount: Number(reservation.deposit_amount),
      currency: reservation.currency,
      createdAt: reservation.created_at,
      refunded: 0,
    }];
  }
  return result.rows;
}

async function writeLedgerRow(client, {
  reservationNo,
  type,
  billingPaymentId,
  depositRef,
  amount,
  currency,
  reason,
  actor,
}) {
  await client.query(
    `INSERT INTO reservation_payments (
      id, reservation_no, type, billing_payment_id, deposit_ref,
      amount, currency, reason, actor_id, actor_role
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      reservationNo,
      type,
      billingPaymentId ?? null,
      depositRef ?? null,
      amount,
      currency,
      reason ?? null,
      actor.id,
      actor.role,
    ],
  );
}

function notificationPayload(reservation, extra = {}) {
  const notificationChannel =
    reservation.notificationChannel ||
    reservation.channel ||
    extra.notificationChannel ||
    extra.channel ||
    "email";
  return {
    reservationNo: reservation.reservationNo,
    guestId: reservation.guestId,
    guestName: reservation.guestName ?? null,
    guestEmail: reservation.guestEmail ?? null,
    guestPhone: reservation.guestPhone ?? null,
    roomTypeId: reservation.roomTypeId,
    roomNumber: reservation.roomNumber ?? null,
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    guests: reservation.guests ?? null,
    totalAmount: Number(reservation.totalAmount),
    depositAmount: reservation.depositAmount == null ? null : Number(reservation.depositAmount),
    refundAmount: extra.refundAmount ?? null,
    statement: extra.statement ?? null,
    cancelledProofs: extra.cancelledProofs ?? [],
    proofRefundDue: extra.proofRefundDue ?? 0,
    cancellationFee: extra.cancellationFee ?? null,
    currency: currencyValue(reservation),
    channel: notificationChannel,
    notificationChannel,
    confirmedAt: extra.confirmedAt || new Date().toISOString(),
    event: extra.event || "ReservationConfirmed",
  };
}

export function createApp({
  db = pool,
  http = createServiceHttp(),
  // Output ports: the app announces events; server.js subscribes the outbox.
  publishEvent = (payload) => domainEvents.publish("ReservationConfirmed", payload),
  publishNotification = (queue, payload) => domainEvents.publish(queue, payload),
  cancellationPolicy = createCancellationPolicy(),
  clock = () => new Date(),
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const required = process.env.INTERNAL_TOKEN;
    if (!required || req.headers['x-internal-token'] === required) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  });

  const today = () => localDate(clock());

  const services = createServiceClients(http);

  const releaseHoldBestEffort = (id) =>
    services.rooms.release(id).catch((error) => {
      console.error(`Failed to release hold ${id}:`, error.message);
    });

  const loadGuestContact = (guestId) => services.guests.contact(guestId);

  // A cancelled booking's payment proofs are cancelled too. Failures are logged
  // and retried when the cancellation is requested again.
  const cancelProofsBestEffort = (reservationNo) =>
    services.billing.cancelProofs(reservationNo).catch((error) => {
      console.error(`Failed to cancel payment proofs for ${reservationNo}:`, error.message);
      return null;
    });

  // Plan the whole refund first (Iterator), so an inconsistent ledger is caught
  // before any money moves.
  async function refundAcrossSources(sources, amount, currency) {
    const refunds = [];
    for (const { source, amount: part } of [...refundPlan(sources, amount)]) {
      const refundId = await services.billing.refund({
        depositId: source.billingPaymentId,
        amount: part,
        currency,
      });
      refunds.push({ source, amount: part, refundId });
    }
    return refunds;
  }

  const ruleContext = (reservation, role) => ({ reservation: stayOf(reservation), today: today(), role });

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.post("/reservations", async (req, res, next) => {
    const { guest, roomTypeId, checkIn, checkOut, channel } = req.body ?? {};
    const guests = parseGuests(req.body?.guests);
    const actor = actorFromRequest(req);

    if (!guest || !roomTypeId || !validDates(checkIn, checkOut) || guests === undefined) {
      return fail(
        res,
        400,
        "BadRequest",
        "Valid guest, room type, and dates are required.",
      );
    }
    if (checkIn < today()) {
      return fail(res, 400, "BadRequest", "Check-in cannot be in the past.");
    }
    if (typeof guest.idDocument !== "string" || !guest.idDocument.trim()) {
      return fail(res, 400, "BadRequest", "A passport or ID number is required to book.");
    }
    const partySize = guests ?? 1;
    const additionalGuests = parseAdditionalGuests(req.body?.additionalGuests) ?? [];
    if (additionalGuests.error || additionalGuests.length !== partySize - 1) {
      return fail(res, 400, "BadRequest", guestDetailsError(partySize));
    }

    const reservationNo = `R-${randomUUID()}`;

    try {
      const result = await runSaga([
        {
          async execute() {
            const availability = await services.rooms.availability({ checkIn, checkOut, roomTypeId, guests });
            if (!availability?.available || availability.roomsAvailable < 1) {
              throw new HttpError(
                409,
                "Conflict",
                guests
                  ? `No rooms of that type are available for ${guests} guest(s) on those dates.`
                  : "No rooms are available for those dates.",
              );
            }
            const amount = totalPrice(availability.nightlyRate, checkIn, checkOut);
            return {
              amount,
              depositAmount: depositPrice(amount),
              currency: availability.currency,
            };
          },
        },
        {
          async execute() {
            return services.rooms.hold({ roomTypeId, checkIn, checkOut });
          },
          async compensate(ctx) {
            await services.rooms.release(ctx.holdId);
          },
        },
        {
          async execute() {
            return services.guests.getOrCreate(guest);
          },
        },
        {
          async execute(ctx) {
            const depositId = await services.billing.authorize({
              reservationNo,
              guestId: ctx.guestId,
              amount: ctx.depositAmount,
              currency: ctx.currency,
            });
            return { depositId };
          },
          async compensate(ctx) {
            if (!ctx.depositId) return;
            await services.billing.refund({
              depositId: ctx.depositId,
              amount: ctx.depositAmount,
              currency: ctx.currency,
            });
          },
        },
        {
          async execute(ctx) {
            const client = await db.connect();
            try {
              await client.query('BEGIN');
              await client.query(
                `INSERT INTO reservations
                  (reservation_no, guest_id, room_type_id, room_id, room_number, hold_id, check_in, check_out,
                   total_amount, deposit_id, deposit_amount, deposit_net, currency, status, guests)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', $14)`,
                [
                  reservationNo,
                  ctx.guestId,
                  roomTypeId,
                  ctx.roomId,
                  ctx.roomNumber,
                  ctx.holdId,
                  checkIn,
                  checkOut,
                  ctx.amount,
                  ctx.depositId,
                  ctx.depositAmount,
                  ctx.depositAmount,
                  ctx.currency,
                  guests,
                ],
              );
              await writeLedgerRow(client, {
                reservationNo,
                type: 'deposit',
                billingPaymentId: ctx.depositId,
                amount: ctx.depositAmount,
                currency: ctx.currency,
                reason: 'initial',
                actor,
              });
              await replaceAdditionalGuests(client, reservationNo, additionalGuests);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK').catch(() => {});
              throw error;
            } finally {
              client.release();
            }
            return { saved: true };
          },
          async compensate() {
            await db.query("DELETE FROM reservations WHERE reservation_no = $1", [
              reservationNo,
            ]);
          },
        },
        {
          async execute(ctx) {
            await services.rooms.confirm(ctx.holdId, "The room hold expired before the booking completed. Please try again.");
          },
        },
      ]);

      // The booking is committed; a broker outage must not undo it.
      try {
        await publishEvent(notificationPayload({
          reservationNo,
          guestId: result.guestId,
          guestName: result.guestName,
          guestEmail: result.guestEmail,
          guestPhone: result.guestPhone,
          roomTypeId,
          roomNumber: result.roomNumber,
          checkIn,
          checkOut,
          guests,
          totalAmount: result.amount,
          depositAmount: result.depositAmount,
          currency: result.currency,
          channel: channel === "sms" ? "sms" : "email",
        }, { event: "ReservationCreated" }));
      } catch (error) {
        console.error(`Failed to publish ReservationConfirmed for ${reservationNo}:`, error);
      }

      return res.status(201).json({
        reservationNo,
        guestId: result.guestId,
        roomTypeId,
        roomId: result.roomId,
        roomNumber: result.roomNumber,
        checkIn,
        checkOut,
        totalAmount: result.amount,
        depositAmount: result.depositAmount,
        depositHeld: result.depositAmount,
        currency: result.currency,
        guests,
        additionalGuests,
        status: "pending",
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(res, error.status, error.error, error.message);
      }
      console.error(error);
      return next(error);
    }
  });

  app.get("/reservations", async (req, res, next) => {
    const { guestId, status, from, to } = req.query;
    const isDate = (value) => value == null || value === "" || validDate(value);

    if (!isDate(from) || !isDate(to)) {
      return fail(
        res,
        400,
        "BadRequest",
        "from and to must be YYYY-MM-DD dates.",
      );
    }

    try {
      const result = await db.query(
        `SELECT ${reservationSelect}
         FROM reservations
         WHERE ($1::text IS NULL OR guest_id = $1)
           AND ($2::text IS NULL OR status = $2)
           AND ($3::date IS NULL OR check_out > $3::date)
           AND ($4::date IS NULL OR check_in < $4::date)
         ORDER BY check_in DESC, created_at DESC`,
        [guestId || null, status || null, from || null, to || null],
      );
      return res.status(200).json({ reservations: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  // Booking counts per guest for the staff guest directory.
  app.get("/reservations/guest-counts", async (_req, res, next) => {
    try {
      const result = await db.query(
        `SELECT guest_id AS "guestId",
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status IN ('pending', 'confirmed') AND checked_out_at IS NULL)::int AS active,
                COUNT(*) FILTER (WHERE checked_out_at IS NOT NULL)::int AS completed,
                COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM reservations
         GROUP BY guest_id`,
      );
      return res.status(200).json({ counts: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/reservations/:no", async (req, res, next) => {
    try {
      const reservation = await loadReservation(db, req.params.no);
      if (!reservation) return fail(res, 404, "NotFound", "Reservation not found.");
      return res.status(200).json({
        ...reservation,
        additionalGuests: await loadAdditionalGuests(db, req.params.no, actorFromRequest(req).role),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/reservations/:no/cancellation-quote", async (req, res, next) => {
    try {
      const reservation = await loadReservation(db, req.params.no);
      if (!reservation) {
        return fail(res, 404, "NotFound", "Reservation not found.");
      }

      const heldAmount = depositHeldValue(reservation);
      const now = clock();
      const checkIn = new Date(`${reservation.checkIn}T00:00:00Z`);
      const hoursBeforeCheckIn = Math.max(0, Math.round((checkIn.getTime() - now.getTime()) / 3_600_000));
      const percent = cancellationPolicy.refundPercent(reservation.checkIn, now);
      const { refundAmount, feeAmount } = quoteFromHours(hoursBeforeCheckIn, heldAmount, percent);

      return res.status(200).json({
        refundAmount,
        feeAmount,
        currency: currencyValue(reservation),
        rule: cancellationPolicy.name || "full",
        hoursBeforeCheckIn,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/reservations/:no/payment-summary", async (req, res, next) => {
    try {
      const reservation = await loadReservation(db, req.params.no);
      if (!reservation) {
        return fail(res, 404, "NotFound", "Reservation not found.");
      }

      const approvedProofsTotal = await services.billing.approvedTotal(req.params.no);
      const heldAmount = depositHeldValue(reservation);
      const amountOwed = reservation.status === "cancelled"
        ? Number(reservation.cancellationFee ?? heldAmount)
        : Number(reservation.totalAmount);
      const settledAtDesk = await settledTotal(db, req.params.no);
      const balanceDue = Math.max(0, roundMoney(amountOwed - heldAmount - approvedProofsTotal - settledAtDesk));

      return res.status(200).json({
        status: reservation.status,
        settledAtDesk,
        totalAmount: Number(reservation.totalAmount),
        depositHeld: heldAmount,
        approvedProofsTotal: roundMoney(approvedProofsTotal),
        balanceDue,
        currency: currencyValue(reservation),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.put("/reservations/:no", async (req, res, next) => {
    const { roomTypeId, checkIn, checkOut } = req.body ?? {};
    const guests = parseGuests(req.body?.guests);
    const actor = actorFromRequest(req);

    if (!roomTypeId || !validDates(checkIn, checkOut) || guests === undefined) {
      return fail(
        res,
        400,
        "BadRequest",
        "Valid room type and dates are required.",
      );
    }

    try {
      const current = await loadRawReservation(db, req.params.no);
      if (!current) return fail(res, 404, "NotFound", "Reservation not found.");

      const denied = stateOf(current).modify(ruleContext(current, actor.role));
      if (denied) return fail(res, ...denied);
      if (checkIn !== current.checkInDate && checkIn < today()) {
        return fail(res, 400, "BadRequest", "Check-in cannot be moved into the past.");
      }
      if (checkOut <= today()) {
        return fail(res, 400, "BadRequest", "Check-out must be after today.");
      }

      const nextGuests = guests ?? current.guests;
      const providedGuests = parseAdditionalGuests(req.body?.additionalGuests);
      const partySize = nextGuests ?? 1;
      const partyChanged = guests != null && guests !== (current.guests ?? 1);
      if (
        providedGuests?.error ||
        (providedGuests && providedGuests.length !== partySize - 1) ||
        (!providedGuests && partyChanged && partySize > 1)
      ) {
        return fail(res, 400, "BadRequest", guestDetailsError(partySize));
      }
      const nextAdditionalGuests = providedGuests ?? (partyChanged ? [] : null);

      const contact = () => loadGuestContact(current.guest_id);
      const unchanged =
        roomTypeId === current.room_type_id &&
        checkIn === current.checkInDate &&
        checkOut === current.checkOutDate &&
        (guests == null || guests === current.guests);
      if (unchanged) {
        if (nextAdditionalGuests) {
          const client = await db.connect();
          try {
            await client.query("BEGIN");
            await replaceAdditionalGuests(client, req.params.no, nextAdditionalGuests);
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
          } finally {
            client.release();
          }
          const updated = await loadReservation(db, req.params.no);
          await publishNotification('ReservationModified', notificationPayload({
            ...updated,
            ...(await contact()),
          }, { event: 'ReservationModified' }));
        }
        return res.status(200).json({
          ...(await loadReservation(db, req.params.no)),
          additionalGuests: await loadAdditionalGuests(db, req.params.no, actor.role),
        });
      }

      const currentHeld = depositHeldValue(current);
      const currency = currencyValue(current);

      const result = await runSaga([
        {
          async execute() {
            const availability = await services.rooms.availability({
              checkIn,
              checkOut,
              roomTypeId,
              guests: nextGuests,
              excludeHoldId: current.hold_id,
            });
            if (!availability?.available || availability.roomsAvailable < 1) {
              throw new HttpError(
                409,
                "Conflict",
                "No rooms are available for those dates.",
              );
            }
            const amount = totalPrice(availability.nightlyRate, checkIn, checkOut);
            const depositAmount = depositPrice(amount);
            return {
              amount,
              depositAmount,
              delta: roundMoney(depositAmount - currentHeld),
            };
          },
        },
        {
          async execute() {
            const held = await services.rooms.hold({ roomTypeId, checkIn, checkOut, excludeHoldId: current.hold_id });
            return { newHoldId: held.holdId, roomId: held.roomId, roomNumber: held.roomNumber };
          },
          async compensate(ctx) {
            await services.rooms.release(ctx.newHoldId);
          },
        },
        {
          async execute(ctx) {
            await services.rooms.confirm(ctx.newHoldId, "The room hold expired before the change completed. Please try again.");
          },
        },
        {
          // The deposit always stays at DEPOSIT_PERCENT of the new total.
          async execute(ctx) {
            if (ctx.delta > 0) {
              const topUpPaymentId = await services.billing.authorize({
                reservationNo: req.params.no,
                guestId: current.guest_id,
                amount: ctx.delta,
                currency,
              });
              return { topUpPaymentId };
            }

            if (ctx.delta < 0) {
              const sources = await loadPaymentSources(db, current);
              const refunds = await refundAcrossSources(sources, Math.abs(ctx.delta), currency);
              return { refunds };
            }

            return {};
          },
          async compensate(ctx) {
            if (!ctx.topUpPaymentId) return;
            await services.billing.refund({ depositId: ctx.topUpPaymentId, amount: ctx.delta, currency });
          },
        },
        {
          async execute(ctx) {
            const client = await db.connect();
            try {
              await client.query('BEGIN');
              const newDepositHeld = roundMoney(currentHeld + ctx.delta);
              const updated = await client.query(
                `UPDATE reservations
                 SET room_type_id = $2, hold_id = $3, check_in = $4,
                     check_out = $5, total_amount = $6, deposit_net = $7,
                     guests = COALESCE($8, guests), room_id = $9, room_number = $10
                 WHERE reservation_no = $1 AND status IN ('pending', 'confirmed') AND checked_in_at IS NULL
                 RETURNING ${reservationSelect}`,
                [
                  req.params.no,
                  roomTypeId,
                  ctx.newHoldId,
                  checkIn,
                  checkOut,
                  ctx.amount,
                  newDepositHeld,
                  guests,
                  ctx.roomId,
                  ctx.roomNumber,
                ],
              );
              if (!updated.rowCount) {
                throw new HttpError(409, "Conflict", "The reservation changed while it was being modified.");
              }

              if (ctx.topUpPaymentId) {
                await writeLedgerRow(client, {
                  reservationNo: req.params.no,
                  type: 'topup',
                  billingPaymentId: ctx.topUpPaymentId,
                  amount: ctx.delta,
                  currency,
                  reason: 'modify_increase',
                  actor,
                });
              }

              for (const refund of ctx.refunds ?? []) {
                await writeLedgerRow(client, {
                  reservationNo: req.params.no,
                  type: 'refund',
                  billingPaymentId: refund.refundId,
                  depositRef: refund.source.billingPaymentId,
                  amount: refund.amount,
                  currency,
                  reason: 'modify_decrease',
                  actor,
                });
              }

              if (nextAdditionalGuests) {
                await replaceAdditionalGuests(client, req.params.no, nextAdditionalGuests);
              }

              await client.query('COMMIT');
              return { updated: updated.rows[0] };
            } catch (error) {
              await client.query('ROLLBACK').catch(() => {});
              throw error;
            } finally {
              client.release();
            }
          },
        },
      ]);

      await releaseHoldBestEffort(current.hold_id);

      await publishNotification('ReservationModified', notificationPayload({
        ...result.updated,
        ...(await contact()),
      }, { event: 'ReservationModified' }));

      return res.status(200).json({
        ...result.updated,
        additionalGuests: await loadAdditionalGuests(db, req.params.no, actor.role),
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(res, error.status, error.error, error.message);
      }
      console.error(error);
      return next(error);
    }
  });

  app.delete("/reservations/:no", async (req, res, next) => {
    try {
      const reservation = await loadRawReservation(db, req.params.no);
      if (!reservation) return fail(res, 404, "NotFound", "Reservation not found.");

      const actor = actorFromRequest(req);
      const state = stateOf(reservation);
      if (state.name === "cancelled") {
        // A previous cancellation may have failed half-way; retry the follow-up steps.
        await releaseHoldBestEffort(reservation.hold_id);
        await cancelProofsBestEffort(req.params.no);
      }
      const denied = state.cancel(ruleContext(reservation, actor.role));
      if (denied) return fail(res, ...denied);
      const waiveFee = req.body?.waiveFee === true || req.body?.waiveFee === 'true';
      if (waiveFee && actor.role !== 'manager') {
        return fail(res, 403, "Forbidden", "Only managers can waive cancellation fees.");
      }

      const currency = currencyValue(reservation);
      const heldAmount = depositHeldValue(reservation);
      const percent = waiveFee ? 100 : cancellationPolicy.refundPercent(
        reservation.checkInDate,
        clock(),
      );
      const refundAmount = Math.round((heldAmount * percent) * 100) / 10000;
      const feeAmount = roundMoney(heldAmount - refundAmount);

      // Claim the reservation first so two concurrent cancellations cannot both refund.
      const memento = await saveMemento(db, req.params.no);
      const claimed = await db.query(
        `UPDATE reservations
         SET status = 'cancelled', cancelled_at = NOW(),
             refund_amount = $2, cancellation_fee = $3, deposit_net = $3
         WHERE reservation_no = $1 AND status IN ('pending', 'confirmed') AND checked_in_at IS NULL`,
        [req.params.no, refundAmount, feeAmount],
      );
      if (!claimed.rowCount) {
        return fail(res, 409, "Conflict", "Reservation is already cancelled.");
      }

      let refunds;
      try {
        const sources = refundAmount > 0 ? await loadPaymentSources(db, reservation) : [];
        refunds = refundAmount > 0 ? await refundAcrossSources(sources, refundAmount, currency) : [];
      } catch (error) {
        await restoreMemento(db, memento);
        throw error;
      }

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        for (const refund of refunds) {
          await writeLedgerRow(client, {
            reservationNo: req.params.no,
            type: 'cancellation_refund',
            billingPaymentId: refund.refundId,
            depositRef: refund.source.billingPaymentId,
            amount: refund.amount,
            currency,
            reason: waiveFee ? 'waived_fee' : 'policy',
            actor,
          });
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }

      await releaseHoldBestEffort(reservation.hold_id);
      const payments = await cancelProofsBestEffort(req.params.no);

      const contact = await loadGuestContact(reservation.guest_id);
      await publishNotification('ReservationCancelled', notificationPayload({
        reservationNo: req.params.no,
        guestId: reservation.guest_id,
        ...contact,
        roomTypeId: reservation.room_type_id,
        roomNumber: reservation.room_number,
        checkIn: reservation.checkInDate,
        checkOut: reservation.checkOutDate,
        totalAmount: reservation.total_amount,
        currency,
      }, {
        event: 'ReservationCancelled',
        refundAmount,
        cancellationFee: feeAmount,
        cancelledProofs: payments?.cancelledProofs ?? [],
        proofRefundDue: payments?.refundDueTotal ?? 0,
      }));

      return res.status(204).end();
    } catch (error) {
      console.error(error);
      return next(error);
    }
  });

  // Internal: billing calls this when staff approve a payment for the booking.
  app.post("/reservations/:no/payment-approved", async (req, res, next) => {
    try {
      const current = await loadReservation(db, req.params.no);
      if (!current) return fail(res, 404, "NotFound", "Reservation not found.");
      const transition = stateOf(current).approvePayment();
      if (transition.error) return fail(res, ...transition.error);

      const updated = await db.query(
        `UPDATE reservations SET status = 'confirmed', confirmed_at = $2
         WHERE reservation_no = $1 AND status = 'pending'
         RETURNING ${reservationSelect}`,
        [req.params.no, clock().toISOString()],
      );
      return res.status(200).json(updated.rows[0] ?? (await loadReservation(db, req.params.no)));
    } catch (error) {
      return next(error);
    }
  });

  app.post("/reservations/:no/check-in", async (req, res, next) => {
    const actor = actorFromRequest(req);
    if (!isStaff(actor.role)) {
      return fail(res, 403, "Forbidden", "Only the front desk or a manager can check guests in.");
    }
    try {
      const reservation = await loadReservation(db, req.params.no);
      if (!reservation) return fail(res, 404, "NotFound", "Reservation not found.");
      const denied = stateOf(reservation).checkIn(ruleContext(reservation, actor.role));
      if (denied) return fail(res, ...denied);

      const updated = await db.query(
        `UPDATE reservations SET checked_in_at = $2, checked_in_by = $3
         WHERE reservation_no = $1 AND status = 'confirmed' AND checked_in_at IS NULL
         RETURNING ${reservationSelect}`,
        [req.params.no, clock().toISOString(), actor.id],
      );
      if (!updated.rowCount) return fail(res, 409, "Conflict", "The guest has already checked in.");
      await publishNotification('ReservationModified', notificationPayload({
        ...updated.rows[0],
        ...(await loadGuestContact(updated.rows[0].guestId)),
      }, { event: 'ReservationCheckedIn' }));
      return res.status(200).json(updated.rows[0]);
    } catch (error) {
      return next(error);
    }
  });

  // Check-out settles the bill: the deposit is applied, approved payments are
  // counted, any balance left must be collected at the desk, and later nights
  // are released for new bookings.
  app.post("/reservations/:no/check-out", async (req, res, next) => {
    const actor = actorFromRequest(req);
    if (!isStaff(actor.role)) {
      return fail(res, 403, "Forbidden", "Only the front desk or a manager can check guests out.");
    }
    try {
      const reservation = await loadRawReservation(db, req.params.no);
      if (!reservation) return fail(res, 404, "NotFound", "Reservation not found.");
      const denied = stateOf(reservation).checkOut(ruleContext(reservation, actor.role));
      if (denied) return fail(res, ...denied);

      const currency = currencyValue(reservation);
      const total = Number(reservation.total_amount);
      const depositApplied = depositHeldValue(reservation);
      const approvedPayments = roundMoney(await services.billing.approvedTotal(req.params.no));
      const settledBefore = await settledTotal(db, req.params.no);
      const balance = Math.max(0, roundMoney(total - depositApplied - approvedPayments - settledBefore));
      if (balance > 0 && req.body?.collectBalance !== true) {
        return res.status(409).json({
          error: "BalanceDue",
          message: `The guest still owes ${balance.toFixed(2)} ${currency}. Collect it at the desk, then check out.`,
          balanceDue: balance,
          currency,
        });
      }

      const memento = await saveMemento(db, req.params.no);
      const claimed = await db.query(
        `UPDATE reservations SET checked_out_at = GREATEST($2::timestamptz, checked_in_at), checked_out_by = $3
         WHERE reservation_no = $1 AND checked_in_at IS NOT NULL AND checked_out_at IS NULL`,
        [req.params.no, clock().toISOString(), actor.id],
      );
      if (!claimed.rowCount) return fail(res, 409, "Conflict", "The guest has already checked out.");

      let settlement = null;
      try {
        await services.billing.captureDeposits(req.params.no);
        if (balance > 0) {
          settlement = await services.billing.settle({
            reservationNo: req.params.no,
            guestId: reservation.guest_id,
            amount: balance,
            currency,
          });
        }
        const client = await db.connect();
        try {
          await client.query("BEGIN");
          if (settlement) {
            await writeLedgerRow(client, {
              reservationNo: req.params.no,
              type: "settlement",
              billingPaymentId: settlement.id,
              amount: balance,
              currency,
              reason: "checkout_balance",
              actor,
            });
          }
          await client.query(
            "UPDATE reservations SET balance_collected = $2 WHERE reservation_no = $1",
            [req.params.no, balance],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        await restoreMemento(db, memento);
        throw error;
      }

      // Free the nights after an early departure; a failure here must not undo the check-out.
      try {
        await services.rooms.complete(reservation.hold_id, today());
      } catch (error) {
        console.error(`Failed to release remaining nights for ${req.params.no}:`, error.message);
      }

      const statement = {
        totalAmount: total,
        depositApplied,
        approvedPayments,
        collectedAtDesk: roundMoney(settledBefore + balance),
        settlementPaymentNo: settlement?.paymentNo ?? null,
        balanceDue: 0,
        currency,
      };
      const updated = await loadReservation(db, req.params.no);
      await publishNotification('ReservationModified', notificationPayload({
        ...updated,
        ...(await loadGuestContact(reservation.guest_id)),
      }, { event: 'ReservationCheckedOut', statement }));

      return res.status(200).json({ ...updated, statement });
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred.",
    });
  });

  return app;
}

export const app = createApp();
