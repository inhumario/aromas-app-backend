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
import { getAllRatings, getReviewsForHandle } from './reviews.js';
import { recordNotification, sendPush } from './push.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

const CUSTOMER_API =
  process.env.SHOPIFY_CUSTOMER_API ||
  'https://shopify.com/79280144711/account/customer/api/2025-01/graphql';

const PANEL_HTML = readFileSync(new URL('./panel.html', import.meta.url), 'utf8');

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

/** Autenticación básica para el panel de administración. */
function adminAuth(req, res, next) {
  const m = /^Basic\s+(.+)$/i.exec(req.get('Authorization') || '');
  if (m) {
    const [user, pass] = Buffer.from(m[1], 'base64').toString().split(':');
    if (process.env.ADMIN_PASSWORD && user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASSWORD) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Aromas - Notificaciones"');
  res.status(401).send('Autenticación requerida.');
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

// Nota media de todos los productos a la vez (para las tarjetas del catálogo).
app.get('/ratings', async (_req, res) => {
  try {
    res.json(await getAllRatings());
  } catch {
    res.json({});
  }
});

/* --- Registro de tokens push (lo llama la app) --- */

app.post('/push/register', async (req, res) => {
  const { token, platform, prefs } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token_required' });
  }
  // Si la app envía el token de cliente, el dispositivo queda asociado a su
  // cuenta para recibir en el buzón los avisos de sus pedidos.
  let customerId = null;
  const authToken = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (authToken) {
    try {
      customerId = await resolveCustomerId(authToken);
    } catch {
      customerId = null;
    }
  }
  await pool.query(
    `INSERT INTO app_push_tokens (token, platform, prefs, customer_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (token)
       DO UPDATE SET platform = $2, prefs = $3, customer_id = $4, updated_at = now()`,
    [token, platform ?? null, JSON.stringify(prefs ?? {}), customerId],
  );
  res.json({ ok: true });
});

/* --- Buzón de notificaciones de la app (historial, lo llama la app) --- */

// Notificaciones visibles para un dispositivo: las generales + las dirigidas
// al cliente dueño de ese token. Marca cuáles ha abierto ya.
app.get('/notifications', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.json({ items: [] });
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.title, n.body, n.category, n.data, n.created_at,
              (r.reader IS NOT NULL) AS read
         FROM app_notifications n
         LEFT JOIN app_notification_reads r
                ON r.notification_id = n.id AND r.reader = $1
        WHERE n.audience = 'all'
           OR n.customer_id = (SELECT customer_id FROM app_push_tokens WHERE token = $1)
        ORDER BY n.created_at DESC
        LIMIT 60`,
      [token],
    );
    res.json({ items: rows });
  } catch (err) {
    console.error('GET /notifications:', err.message);
    res.json({ items: [] });
  }
});

// Marca una notificación como abierta por este dispositivo (también mide la
// apertura para las estadísticas del panel).
app.post('/notifications/read', async (req, res) => {
  const { token, id } = req.body || {};
  if (!token || !id) return res.status(400).json({ error: 'token_id_required' });
  try {
    await pool.query(
      `INSERT INTO app_notification_reads (notification_id, reader)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, token],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /notifications/read:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/* --- Panel de envío de notificaciones (protegido con usuario/contraseña) --- */

app.get('/admin', adminAuth, (_req, res) => {
  res.type('html').send(PANEL_HTML);
});

app.post('/admin/push', adminAuth, async (req, res) => {
  const { title, body, category, path } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title_body_required' });
  const cat = typeof category === 'string' ? category : '';
  const data = { category: cat || 'general' };
  if (typeof path === 'string' && path.trim()) data.path = path.trim();

  // Se guarda primero para conocer el id y mandarlo dentro de la notificación
  // (así, al pulsarla, la app puede marcarla leída en el buzón).
  const id = await recordNotification(pool, { title, body, category: cat, data, audience: 'all' });
  const result = await sendPush(pool, {
    title,
    body,
    category: cat,
    data: id != null ? { ...data, notifId: id } : data,
  });
  if (id != null) {
    await pool.query('UPDATE app_notifications SET recipients = $1 WHERE id = $2', [
      result.recipients,
      id,
    ]);
  }
  res.json({ ok: true, ...result });
});

// Historial de notificaciones con estadísticas de apertura (para el panel).
app.get('/admin/notifications', adminAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.title, n.body, n.category, n.audience, n.recipients, n.created_at,
              COUNT(r.reader)::int AS opens
         FROM app_notifications n
         LEFT JOIN app_notification_reads r ON r.notification_id = n.id
        GROUP BY n.id
        ORDER BY n.created_at DESC
        LIMIT 50`,
    );
    res.json({ items: rows });
  } catch (err) {
    console.error('GET /admin/notifications:', err.message);
    res.json({ items: [] });
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
