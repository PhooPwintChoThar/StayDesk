// Chain of Responsibility: authenticate -> authorize -> route.
// Splits gateway security so role rules can change without touching proxying (NFR-3, NFR-7).

const ROLES = ["guest", "agent", "manager"];

// Holds, deposits and refunds are driven by the reservation saga only; exposing
// them would let callers block rooms or move money outside the reservation ledger.
export function isInternalOnly(path) {
  return /^\/(holds|deposits|refunds|settlements)(\/|$)/.test(path) ||
    path.startsWith("/payments/reservations/") ||
    /^\/reservations\/[^/]+\/payment-approved$/.test(path);
}

const MANAGER_WRITE_ROUTES = /^\/(rooms|room-types)(\/.*)?$/;

export function serviceForPath(path) {
  if (isInternalOnly(path)) return null;
  if (
    path === "/availability" ||
    path === "/room-types" ||
    path === "/rooms" ||
    path.startsWith("/room-types/") ||
    path.startsWith("/rooms/")
  ) {
    return ["ROOM_RATE_SERVICE_URL", "http://room-rate:3000"];
  }
  if (path === "/auth/register") {
    return ["GUEST_SERVICE_URL", "http://guest:3000"];
  }
  if (path.startsWith("/guests")) return ["GUEST_SERVICE_URL", "http://guest:3000"];
  if (path === "/payments" || path.startsWith("/payments/")) {
    return ["BILLING_SERVICE_URL", "http://billing:3000"];
  }
  if (path === "/reservations" || path.startsWith("/reservations/")) {
    return ["RESERVATION_SERVICE_URL", "http://reservation:3000"];
  }
  return null;
}

const ROOM_PHOTO = /^\/room-types\/[^/]+\/photos\/[^/]+$/;

export function isPublicRoute(method, path) {
  return (
    method === "GET" &&
    (path === "/availability" || path === "/room-types" || ROOM_PHOTO.test(path))
  ) || (method === "POST" && path === "/auth/register");
}

export function allowedForGuest(method, path) {
  return (
    (method === "GET" && path === "/availability") ||
    (method === "GET" && path === "/room-types") ||
    (method === "GET" && ROOM_PHOTO.test(path)) ||
    (method === "GET" && path === "/reservations") ||
    (method === "POST" && path === "/reservations") ||
    (["GET", "PUT", "DELETE"].includes(method) &&
      /^\/reservations\/[^/]+$/.test(path)) ||
    (method === "GET" &&
      /^\/reservations\/[^/]+\/(payment-summary|cancellation-quote)$/.test(path)) ||
    (method === "POST" && path === "/guests/get-or-create") ||
    (method === "GET" && /^\/guests\/[^/]+$/.test(path)) ||
    (method === "PUT" && /^\/guests\/[^/]+$/.test(path)) ||
    (method === "POST" && path === "/payments/proofs") ||
    (method === "GET" && path === "/payments/proofs") ||
    (method === "GET" && /^\/payments\/proofs\/[^/]+\/file$/.test(path))
  );
}

export function isOwnershipRoute(path) {
  return /^\/reservations\/[^/]+(?:\/(payment-summary|cancellation-quote))?$/.test(path) ||
    /^\/guests\/[^/]+$/.test(path);
}

function userIdForClaims(ctx) {
  return ctx.role === "guest" ? ctx.claims?.guestId : ctx.claims?.sub;
}

function bearerToken(req) {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

export class Handler {
  setNext(handler) {
    this.next = handler;
    return handler;
  }

  handle(ctx) {
    if (this.next) return this.next.handle(ctx);
    return ctx.res.status(500).json({ error: "InternalServerError" });
  }
}

export class AuthenticateHandler extends Handler {
  constructor(verifyJwt) {
    super();
    this.verifyJwt = verifyJwt;
  }

  handle(ctx) {
    const { req, res } = ctx;
    if (isPublicRoute(req.method, req.path)) {
      ctx.role = "guest";
      return super.handle(ctx);
    }

    const token = bearerToken(req);
    if (!token || !ctx.secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      ctx.claims = this.verifyJwt(token, ctx.secret);
      ctx.role = ctx.claims.role;
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!ROLES.includes(ctx.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return super.handle(ctx);
  }
}

export class AuthorizeHandler extends Handler {
  handle(ctx) {
    const { req, res, role } = ctx;
    const service = serviceForPath(req.path);
    if (!service) {
      return res.status(404).json({ error: "NotFound" });
    }

    if (role === "guest" && !allowedForGuest(req.method, req.path)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (
      MANAGER_WRITE_ROUTES.test(req.path) &&
      ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) &&
      role !== "manager"
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (
      req.method === "DELETE" &&
      /^\/guests\/[^/]+$/.test(req.path) &&
      role !== "manager"
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    ctx.service = service;
    return super.handle(ctx);
  }
}

export class RouteHandler extends Handler {
  constructor(http) {
    super();
    this.http = http;
  }

  async handle(ctx) {
    const { req, res, service } = ctx;
    const [envName, fallback] = service;
    const baseUrl = (process.env[envName] || fallback).replace(/\/$/, "");
    const isMultipart = req.headers["content-type"]?.includes("multipart/form-data");
    const target = new URL(req.originalUrl, "http://gateway.local");

    if (ctx.role === "guest" && req.method === "POST" && req.path === "/reservations") {
      const requestedEmail = req.body?.guest?.email;
      const authenticatedEmail = ctx.claims?.sub;
      if (
        typeof requestedEmail !== "string" ||
        typeof authenticatedEmail !== "string" ||
        !ctx.claims?.guestId ||
        requestedEmail.trim().toLowerCase() !== authenticatedEmail.trim().toLowerCase()
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    if (ctx.role === "guest" && isOwnershipRoute(req.path)) {
      if (!ctx.claims?.guestId) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const owns = await this.isOwner(ctx, baseUrl);
      if (!owns) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    if (ctx.role === "guest" && req.method === "GET" && req.path === "/reservations") {
      for (const key of [...target.searchParams.keys()]) {
        if (key.toLowerCase().startsWith("guest")) target.searchParams.delete(key);
      }
      target.searchParams.set("guestId", ctx.claims.guestId);
    }

    try {
      const response = await this.http.request({
        method: req.method,
        url: `${baseUrl}${target.pathname}${target.search}`,
        data: isMultipart ? req : req.body,
        headers: {
          "content-type": req.headers["content-type"] || "application/json",
          ...(isMultipart && req.headers["content-length"] ? { "content-length": req.headers["content-length"] } : {}),
          ...(userIdForClaims(ctx) ? { "x-user-id": userIdForClaims(ctx) } : {}),
          ...(ctx.role ? { "x-user-role": ctx.role } : {}),
          ...(process.env.INTERNAL_TOKEN ? { "x-internal-token": process.env.INTERNAL_TOKEN } : {}),
          ...(req.headers["x-request-id"]
            ? { "x-request-id": req.headers["x-request-id"] }
            : {}),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        // Raw bytes: files and photos must pass through unchanged.
        responseType: "arraybuffer",
        validateStatus: () => true,
      });

      for (const header of ["content-type", "content-disposition", "cache-control"]) {
        if (response.headers?.[header]) res.setHeader(header, response.headers[header]);
      }
      res.status(response.status);
      if (response.status === 204 || response.status === 304) return res.end();
      return res.send(Buffer.from(response.data ?? ""));
    } catch {
      return res.status(502).json({ error: "BadGateway" });
    }
  }

  async isOwner(ctx, baseUrl) {
    const { req } = ctx;
    if (req.path.startsWith("/reservations/")) {
      const reservationPath = req.path.replace(/\/(?:payment-summary|cancellation-quote)$/, "");
      const response = await this.http.request({
        method: "GET",
        url: `${baseUrl}${reservationPath}`,
        headers: {
          ...(process.env.INTERNAL_TOKEN ? { "x-internal-token": process.env.INTERNAL_TOKEN } : {}),
          ...(userIdForClaims(ctx) ? { "x-user-id": userIdForClaims(ctx) } : {}),
          ...(ctx.role ? { "x-user-role": ctx.role } : {}),
        },
        validateStatus: () => true,
      });
      return response.status === 200 && response.data?.guestId === ctx.claims.guestId;
    }

    if (req.path.startsWith("/guests/")) {
      return req.path.split("/")[2] === ctx.claims.guestId;
    }

    return false;
  }
}

export function buildGatewayChain({ http, verifyJwt }) {
  const authenticate = new AuthenticateHandler(verifyJwt);
  authenticate.setNext(new AuthorizeHandler()).setNext(new RouteHandler(http));
  return authenticate;
}

export { ROLES };
