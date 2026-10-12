import axios from 'axios';
import express from 'express';
import jwt from 'jsonwebtoken';
import cors from 'cors';

const ROLES = ['guest', 'agent', 'manager'];

const serviceForPath = (path) => {
  if (path === '/availability' || path === '/holds' || path.startsWith('/holds/')) {
    return ['ROOM_RATE_SERVICE_URL', 'http://room-rate:3000'];
  }
  if (path.startsWith('/guests')) return ['GUEST_SERVICE_URL', 'http://guest:3000'];
  if (path === '/deposits' || path === '/refunds') {
    return ['BILLING_SERVICE_URL', 'http://billing:3000'];
  }
  if (path === '/reservations' || path.startsWith('/reservations/')) {
    return ['RESERVATION_SERVICE_URL', 'http://reservation:3000'];
  }
  return null;
};

function allowedForGuest(method, path) {
  return (method === 'GET' && path === '/availability')
    || (method === 'POST' && path === '/reservations')
    || (method === 'GET' && /^\/reservations\/[^/]+$/.test(path))
    || (method === 'POST' && path === '/guests/get-or-create');
}

function bearerToken(req) {
  const value = req.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

export function createApp({
  http = axios,
  secret = process.env.JWT_SECRET
} = {}) {
  const app = express();
  app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.post('/login', (req, res) => {
    const role = req.body?.role;
    if (!ROLES.includes(role) || !secret) {
      return res.status(400).json({ error: 'BadRequest' });
    }
    res.json({ token: jwt.sign({ role }, secret, { expiresIn: '8h' }) });
  });

  app.use(async (req, res) => {
    const isPublic = req.method === 'GET' && req.path === '/availability';
    let role = 'guest';

    if (!isPublic) {
      const token = bearerToken(req);
      if (!token || !secret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      try {
        role = jwt.verify(token, secret).role;
      } catch {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!ROLES.includes(role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const service = serviceForPath(req.path);
    if (!service) {
      return res.status(404).json({ error: 'NotFound' });
    }

    if (role === 'guest' && !allowedForGuest(req.method, req.path)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const [envName, fallback] = service;
    const baseUrl = (process.env[envName] || fallback).replace(/\/$/, '');

    try {
      const response = await http.request({
        method: req.method,
        url: `${baseUrl}${req.originalUrl}`,
        data: req.body,
        headers: {
          'content-type': req.headers['content-type'] || 'application/json',
          ...(req.headers['x-request-id']
            ? { 'x-request-id': req.headers['x-request-id'] }
            : {})
        },
        validateStatus: () => true
      });

      return res.status(response.status).send(response.data);
    } catch {
      return res.status(502).json({ error: 'BadGateway' });
    }
  });

  return app;
}

export const app = createApp();