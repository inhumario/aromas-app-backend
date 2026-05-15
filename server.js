/**
 * Backend de la app Aromas de Té.
 *
 * API mínima para la lista de deseos y las notas de cata del cliente. Los datos
 * se guardan en Postgres, por cliente. La identidad del cliente se valida
 * contra la Customer Account API de Shopify: la app envía su token de cliente
 * y este servidor lo verifica para obtener el ID del cliente.
 *
 * Variables de entorno: ver `.env.example`.
 */
import cors from 'cors';
import express from 'express';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { getReviewsForHandle } from './reviews.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

const CUSTOMER_API =
  process.env.SHOPIFY_CUSTOMER_API ||
  'https://shopify.com/79280144711/account/customer/api/2025-01/graphql';

/* --------------------------- Base de datos --------------------------- */

async function initDb() {
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await pool.query(sql);
      console.log('Esquema de base de datos listo.');
      return;
    } catch (err) {
      console.error(`initDb intento ${attempt}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/* ----------------------- Verificación del cliente -------------------- */

// token -> { customerId, expiresAt }
const tokenCache = new Map();

async function resolveCustomerId(token) {
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.customerId;

  const res = await fetch(CUSTOMER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query: '{ customer { id } }' }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const customerId = json?.data?.customer?.id ?? null;
  if (customerId) {
    tokenCache.set(token, { customerId, expiresAt: Date.now() + 5 * 60_000 });
  }
  return customerId;
}

async function auth(req, res, next) {
  const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    const customerId = await resolveCustomerId(token);
    if (!customerId) return res.status(401).json({ error: 'invalid_token' });
    req.customerId = customerId;
    next();
  } catch {
    res.status(502).json({ error: 'auth_check_failed' });
  }
}

/* ------------------------------- App --------------------------------- */

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'aromas-app-backend' }));

/* --- Valoraciones de producto (Trusted Shops) — público --- */

app.get('/reviews/:handle', async (req, res) => {
  try {
    res.json(await getReviewsForHandle(req.params.handle));
  } catch {
    res.json({ handle: req.params.handle, rating: null, count: 0, items: [] });
  }
});

/* --- Lista de deseos --- */

app.get('/me/wishlist', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT product_id, handle, title, image_url, created_at
       FROM app_wishlist WHERE customer_id = $1 ORDER BY created_at DESC`,
    [req.customerId],
  );
  res.json({ items: rows });
});

app.post('/me/wishlist', auth, async (req, res) => {
  const { productId, handle, title, imageUrl } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'productId_required' });
  await pool.query(
    `INSERT INTO app_wishlist (customer_id, product_id, handle, title, image_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (customer_id, product_id)
       DO UPDATE SET handle = $3, title = $4, image_url = $5`,
    [req.customerId, productId, handle ?? null, title ?? null, imageUrl ?? null],
  );
  res.json({ ok: true });
});

app.delete('/me/wishlist/:productId', auth, async (req, res) => {
  await pool.query('DELETE FROM app_wishlist WHERE customer_id = $1 AND product_id = $2', [
    req.customerId,
    req.params.productId,
  ]);
  res.json({ ok: true });
});

/* --- Notas de cata --- */

app.get('/me/tasting-notes', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT product_id, handle, title, image_url, rating, note, updated_at
       FROM app_tasting_notes WHERE customer_id = $1 ORDER BY updated_at DESC`,
    [req.customerId],
  );
  res.json({ items: rows });
});

app.put('/me/tasting-notes/:productId', auth, async (req, res) => {
  const { handle, title, imageUrl, rating, note } = req.body || {};
  if (rating !== 'like' && rating !== 'dislike') {
    return res.status(400).json({ error: 'rating_invalid' });
  }
  await pool.query(
    `INSERT INTO app_tasting_notes (customer_id, product_id, handle, title, image_url, rating, note, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (customer_id, product_id)
       DO UPDATE SET handle = $3, title = $4, image_url = $5, rating = $6, note = $7, updated_at = now()`,
    [req.customerId, req.params.productId, handle ?? null, title ?? null, imageUrl ?? null, rating, note ?? null],
  );
  res.json({ ok: true });
});

app.delete('/me/tasting-notes/:productId', auth, async (req, res) => {
  await pool.query('DELETE FROM app_tasting_notes WHERE customer_id = $1 AND product_id = $2', [
    req.customerId,
    req.params.productId,
  ]);
  res.json({ ok: true });
});

/* --- Errores --- */

app.use((err, _req, res, _next) => {
  console.error('Error no controlado:', err);
  res.status(500).json({ error: 'server_error' });
});

const PORT = process.env.PORT || 3000;
initDb();
app.listen(PORT, () => console.log(`Backend de Aromas de Té escuchando en :${PORT}`));
