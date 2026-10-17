import axios from 'axios';
import express from 'express';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { ROLES, buildGatewayChain, isOwnershipRoute } from './auth-chain.js';

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;
const ALLOW_DEV_LOGIN = process.env.ALLOW_DEV_LOGIN !== 'false';
const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const loginAttempts = new Map();

const internalUsers = () => {
  const raw = process.env.USERS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [];
    }
  }

  return [
    { username: 'agent', role: 'agent', passwordHash: bcrypt.hashSync('agent123', 10) },
    { username: 'manager', role: 'manager', passwordHash: bcrypt.hashSync('manager123', 10) },
  ];
};

function loginAllowed(ip) {
  const now = Date.now();
  const current = loginAttempts.get(ip) || [];
  const recent = current.filter((time) => now - time < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_LIMIT) {
    loginAttempts.set(ip, recent);
    return false;
  }
  recent.push(now);
  loginAttempts.set(ip, recent);
  return true;
}

async function authGuest(http, email, password) {
  const response = await http.post(`${process.env.GUEST_SERVICE_URL || 'http://guest:3000'}/auth/login`, {
    email,
    password,
  });
  return response.data;
}

async function registerGuest(http, body) {
  const response = await http.post(`${process.env.GUEST_SERVICE_URL || 'http://guest:3000'}/auth/register`, body);
  return response.data;
}

export function createApp({
  http = axios,
  secret = process.env.JWT_SECRET,
  verifyJwt = (token, key) => jwt.verify(token, key)
} = {}) {
  const app = express();
  app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
  app.use(express.json());

  const chain = buildGatewayChain({ http, verifyJwt });

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.post('/login', (req, res) => {
    if (!loginAllowed(req.ip)) {
      return res.status(429).json({ error: 'TooManyRequests' });
    }

    const { role, username, password } = req.body ?? {};
    if (ALLOW_DEV_LOGIN && role) {
      if (!ROLES.includes(role) || !secret) {
        return res.status(400).json({ error: 'BadRequest' });
      }
      return res.json({ token: jwt.sign({ role }, secret, { expiresIn: '8h' }) });
    }

    if (!username || !password || !secret) {
      return res.status(400).json({ error: 'BadRequest' });
    }

    const user = internalUsers().find((item) => item.username === username);
    if (user) {
      const ok = bcrypt.compareSync(password, user.passwordHash);
      if (!ok) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.json({ token: jwt.sign({ sub: username, role: user.role }, secret, { expiresIn: '8h' }) });
    }

    authGuest(http, username, password)
      .then((data) => res.json({ token: jwt.sign({ sub: username, role: 'guest', guestId: data.guestId }, secret, { expiresIn: '8h' }) }))
      .catch((error) => {
        const status = error.response?.status || 401;
        return res.status(status).json({ error: error.response?.data?.error || 'Unauthorized' });
      });
  });

  app.post('/auth/register', async (req, res) => {
    try {
      const result = await registerGuest(http, req.body);
      return res.status(201).json(result);
    } catch (error) {
      return res.status(error.response?.status || 500).json(error.response?.data || { error: 'InternalServerError' });
    }
  });

  app.use((req, res) => chain.handle({ req, res, secret }));

  return app;
}

export const app = createApp();
