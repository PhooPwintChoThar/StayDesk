import express from 'express';

export const app = express();

app.use(express.json());
app.use((req, res, next) => {
  const required = process.env.INTERNAL_TOKEN;
  if (!required || req.headers['x-internal-token'] === required) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
