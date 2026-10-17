// Chain of Responsibility: authenticate -> authorize -> route.
// Splits gateway security so role rules can change without touching proxying (NFR-3, NFR-7).

const ROLES = ["guest", "agent", "manager"];

export function serviceForPath(path) {
  if (
    path === "/availability" ||
    path === "/hotels" ||
    path === "/holds" ||
    path.startsWith("/holds/")
  ) {
    return ["ROOM_RATE_SERVICE_URL", "http://room-rate:3000"];
  }
  if (path === "/auth/register") {
    return ["GUEST_SERVICE_URL", "http://guest:3000"];
  }
  if (path.startsWith("/guests")) return ["GUEST_SERVICE_URL", "http://guest:3000"];
  if (path === "/deposits" || path === "/refunds") {
    return ["BILLING_SERVICE_URL", "http://billing:3000"];
  }
  if (path === "/reservations" || path.startsWith("/reservations/")) {
    return ["RESERVATION_SERVICE_URL", "http://reservation:3000"];
  }
  return null;
}

export function isPublicRoute(method, path) {
  return (
    method === "GET" &&
    (path === "/availability" || path === "/hotels")
  ) || (method === "POST" && path === "/auth/register");
}

export function allowedForGuest(method, path) {
  return (
    (method === "GET" && path === "/availability") ||
    (method === "GET" && path === "/hotels") ||
    (method === "POST" && path === "/reservations") ||
    (["GET", "PUT", "DELETE"].includes(method) &&
      /^\/reservations\/[^/]+$/.test(path)) ||
    (method === "POST" && path === "/guests/get-or-create") ||
    (method === "GET" && /^\/guests\/[^/]+$/.test(path)) ||
    (method === "PUT" && /^\/guests\/[^/]+$/.test(path))
  );
}

export function isOwnershipRoute(path) {
  return /^\/(reservations|guests)\/[^/]+$/.test(path);
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

    if (ctx.role === "guest" && ctx.claims?.guestId && isOwnershipRoute(req.path)) {
      const owns = await this.isOwner(ctx, baseUrl);
      if (!owns) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    try {
      const response = await this.http.request({
        method: req.method,
        url: `${baseUrl}${req.originalUrl}`,
        data: req.body,
        headers: {
          "content-type": req.headers["content-type"] || "application/json",
          ...(ctx.claims?.sub || ctx.claims?.guestId ? { "x-user-id": ctx.claims.sub || ctx.claims.guestId } : {}),
          ...(ctx.role ? { "x-user-role": ctx.role } : {}),
          ...(process.env.INTERNAL_TOKEN ? { "x-internal-token": process.env.INTERNAL_TOKEN } : {}),
          ...(req.headers["x-request-id"]
            ? { "x-request-id": req.headers["x-request-id"] }
            : {}),
        },
        validateStatus: () => true,
      });

      return res.status(response.status).send(response.data);
    } catch {
      return res.status(502).json({ error: "BadGateway" });
    }
  }

  async isOwner(ctx, baseUrl) {
    const { req } = ctx;
    if (req.path.startsWith("/reservations/")) {
      const response = await this.http.request({
        method: "GET",
        url: `${baseUrl}${req.originalUrl}`,
        headers: {
          ...(process.env.INTERNAL_TOKEN ? { "x-internal-token": process.env.INTERNAL_TOKEN } : {}),
          ...(ctx.claims?.sub || ctx.claims?.guestId ? { "x-user-id": ctx.claims.sub || ctx.claims.guestId } : {}),
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
