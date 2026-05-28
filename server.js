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
import { handleOrderWebhook, verifyShopifyHmac } from './webhooks.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

const CUSTOMER_API =
  process.env.SHOPIFY_CUSTOMER_API ||
  'https://shopify.com/79280144711/account/customer/api/2025-01/graphql';

const PANEL_HTML = readFileSync(new URL('./panel.html', import.meta.url), 'utf8');

// URL pública del backend, para construir el enlace de la imagen del popup.
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://app-api.aromasdete.com';

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

/* -------------------- Contenido editable del inicio ------------------ */

// Columnas de `app_home_promo` que se devuelven a la app/panel. NO incluye
// `popup_image_data` (el binario de la imagen, que puede pesar): se sirve
// aparte en GET /home/promo/image. `has_image` indica si hay imagen subida.
const PROMO_COLS = `id, pill_enabled, pill_emoji, pill_label, pill_text,
  popup_enabled, popup_title, popup_body, popup_image,
  link, pill_link, popup_link, cta_label,
  revision, updated_at,
  (popup_image_data IS NOT NULL) AS has_image,
  (pill_image_data IS NOT NULL) AS has_pill_image`;

/** Normaliza un texto del formulario: vacío o no-texto -> null. */
function cleanText(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length ? s : null;
}

/** Fila `app_home_promo` -> objeto JSON con claves camelCase para la app. */
function promoToJson(row) {
  if (!row) {
    return {
      pillEnabled: false, pillEmoji: null, pillLabel: null, pillText: null,
      pillImage: null,
      popupEnabled: false, popupTitle: null, popupBody: null, popupImage: null,
      link: null, pillLink: null, popupLink: null,
      ctaLabel: null, revision: 0, updatedAt: null,
    };
  }
  // `pill_link`/`popup_link` se introdujeron después de `link`. Si están
  // vacíos, se cae al `link` viejo para compatibilidad. `link` se mantiene
  // en la respuesta para que versiones de la app anteriores (que solo lo
  // conocían a él) sigan funcionando con el destino más visible.
  const pillLink = row.pill_link ?? row.link ?? null;
  const popupLink = row.popup_link ?? row.link ?? null;
  return {
    pillEnabled: !!row.pill_enabled,
    pillEmoji: row.pill_emoji,
    pillLabel: row.pill_label,
    pillText: row.pill_text,
    // Imagen opcional de la pastilla; se sirve aparte como la del popup.
    pillImage: row.has_pill_image
      ? `${PUBLIC_BASE}/home/promo/pill-image?v=${row.revision}`
      : null,
    popupEnabled: !!row.popup_enabled,
    popupTitle: row.popup_title,
    popupBody: row.popup_body,
    // Imagen subida desde el panel; si no hay, la URL externa (campo antiguo).
    // El `?v=` con la revisión refresca la caché cuando la imagen cambia.
    popupImage: row.has_image
      ? `${PUBLIC_BASE}/home/promo/image?v=${row.revision}`
      : row.popup_image || null,
    link: row.link ?? pillLink,
    pillLink,
    popupLink,
    ctaLabel: row.cta_label,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------- App --------------------------------- */

const app = express();
app.use(cors());
app.use(
  express.json({
    limit: '256kb',
    // Conserva el cuerpo en crudo para verificar la firma HMAC de los webhooks.
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

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

/* --- Contenido editable del inicio (pastilla + popup) — público --- */

// Lo llama la app al arrancar para pintar la pastilla de ofertas y decidir
// si mostrar el mini popup de bienvenida.
app.get('/home/promo', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${PROMO_COLS} FROM app_home_promo WHERE id = 1`);
    res.json(promoToJson(rows[0]));
  } catch (err) {
    console.error('GET /home/promo:', err.message);
    res.json(promoToJson(null));
  }
});

// Imagen del popup que Mario sube desde el panel. Pública (la pide la app).
app.get('/home/promo/image', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT popup_image_data, popup_image_mime FROM app_home_promo WHERE id = 1',
    );
    const r = rows[0];
    if (!r || !r.popup_image_data) return res.status(404).end();
    res.set('Content-Type', r.popup_image_mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.popup_image_data);
  } catch (err) {
    console.error('GET /home/promo/image:', err.message);
    res.status(500).end();
  }
});

// Imagen de la pastilla (opcional). Pública igual que la del popup.
app.get('/home/promo/pill-image', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT pill_image_data, pill_image_mime FROM app_home_promo WHERE id = 1',
    );
    const r = rows[0];
    if (!r || !r.pill_image_data) return res.status(404).end();
    res.set('Content-Type', r.pill_image_mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.pill_image_data);
  } catch (err) {
    console.error('GET /home/promo/pill-image:', err.message);
    res.status(500).end();
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
        WHERE (n.audience = 'all'
               OR n.customer_id = (SELECT customer_id FROM app_push_tokens WHERE token = $1))
          AND NOT EXISTS (
            SELECT 1 FROM app_notification_dismissed d
             WHERE d.notification_id = n.id AND d.reader = $1
          )
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

// Borra una notificación del buzón de este dispositivo (o todas con `all`).
app.post('/notifications/dismiss', async (req, res) => {
  const { token, id, all } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token_required' });
  try {
    if (all) {
      await pool.query(
        `INSERT INTO app_notification_dismissed (notification_id, reader)
           SELECT n.id, $1 FROM app_notifications n
            WHERE n.audience = 'all'
               OR n.customer_id = (SELECT customer_id FROM app_push_tokens WHERE token = $1)
         ON CONFLICT DO NOTHING`,
        [token],
      );
    } else if (id) {
      await pool.query(
        `INSERT INTO app_notification_dismissed (notification_id, reader)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, token],
      );
    } else {
      return res.status(400).json({ error: 'id_or_all_required' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /notifications/dismiss:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/* --- Webhooks de Shopify: avisos automáticos del estado del pedido --- */

app.post('/webhooks/shopify/order', (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const topic = req.get('X-Shopify-Topic') || '';
  if (!verifyShopifyHmac(req.rawBody, hmac, process.env.SHOPIFY_WEBHOOK_SECRET)) {
    return res.status(401).send('invalid hmac');
  }
  // Shopify exige una respuesta rápida: se confirma y se procesa después.
  res.json({ ok: true });
  handleOrderWebhook(pool, topic, req.body || {}).catch((err) =>
    console.error('webhook order:', err.message),
  );
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

// Contenido editable del inicio: leer (para rellenar el formulario del panel).
app.get('/admin/promo', adminAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${PROMO_COLS} FROM app_home_promo WHERE id = 1`);
    res.json(promoToJson(rows[0]));
  } catch (err) {
    console.error('GET /admin/promo:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Contenido editable del inicio: guardar. `revision` sube en cada guardado
// para que el popup vuelva a aparecer una vez a quien ya lo había visto.
// La imagen del popup se sube aparte (POST /admin/promo/image).
app.post('/admin/promo', adminAuth, async (req, res) => {
  const b = req.body || {};
  // `link` legacy: se sigue rellenando para que versiones de la app
  // anteriores (que solo conocen ese campo) tengan un destino sensato.
  // Prioridad: el de la pastilla (más visible que el del popup).
  const pillLink = cleanText(b.pillLink);
  const popupLink = cleanText(b.popupLink);
  const legacyLink = pillLink ?? popupLink ?? cleanText(b.link);
  try {
    const { rows } = await pool.query(
      `UPDATE app_home_promo SET
         pill_enabled = $1, pill_emoji = $2, pill_label = $3, pill_text = $4,
         popup_enabled = $5, popup_title = $6, popup_body = $7,
         link = $8, pill_link = $9, popup_link = $10, cta_label = $11,
         revision = revision + 1, updated_at = now()
       WHERE id = 1
       RETURNING ${PROMO_COLS}`,
      [
        !!b.pillEnabled, cleanText(b.pillEmoji), cleanText(b.pillLabel), cleanText(b.pillText),
        !!b.popupEnabled, cleanText(b.popupTitle), cleanText(b.popupBody),
        legacyLink, pillLink, popupLink, cleanText(b.ctaLabel),
      ],
    );
    res.json(promoToJson(rows[0]));
  } catch (err) {
    console.error('POST /admin/promo:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Subir la imagen del popup. El cuerpo es el fichero en crudo y el Content-Type
// indica el tipo. Sube `revision` para que la app refresque la imagen.
app.post(
  '/admin/promo/image',
  adminAuth,
  express.raw({ type: () => true, limit: '8mb' }),
  async (req, res) => {
    const mime = (req.get('Content-Type') || '').split(';')[0].trim();
    if (!mime.startsWith('image/')) return res.status(400).json({ error: 'not_an_image' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty_file' });
    try {
      const { rows } = await pool.query(
        `UPDATE app_home_promo
            SET popup_image_data = $1, popup_image_mime = $2,
                revision = revision + 1, updated_at = now()
          WHERE id = 1
          RETURNING revision`,
        [req.body, mime],
      );
      res.json({ ok: true, url: `${PUBLIC_BASE}/home/promo/image?v=${rows[0].revision}` });
    } catch (err) {
      console.error('POST /admin/promo/image:', err.message);
      res.status(500).json({ error: 'server_error' });
    }
  },
);

// Quitar la imagen del popup.
app.delete('/admin/promo/image', adminAuth, async (_req, res) => {
  try {
    await pool.query(
      `UPDATE app_home_promo
          SET popup_image_data = NULL, popup_image_mime = NULL,
              revision = revision + 1, updated_at = now()
        WHERE id = 1`,
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/promo/image:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Subir y quitar imagen de la pastilla (idénticos a los del popup).
app.post(
  '/admin/promo/pill-image',
  adminAuth,
  express.raw({ type: () => true, limit: '8mb' }),
  async (req, res) => {
    const mime = (req.get('Content-Type') || '').split(';')[0].trim();
    if (!mime.startsWith('image/')) return res.status(400).json({ error: 'not_an_image' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty_file' });
    try {
      const { rows } = await pool.query(
        `UPDATE app_home_promo
            SET pill_image_data = $1, pill_image_mime = $2,
                revision = revision + 1, updated_at = now()
          WHERE id = 1
          RETURNING revision`,
        [req.body, mime],
      );
      res.json({ ok: true, url: `${PUBLIC_BASE}/home/promo/pill-image?v=${rows[0].revision}` });
    } catch (err) {
      console.error('POST /admin/promo/pill-image:', err.message);
      res.status(500).json({ error: 'server_error' });
    }
  },
);

app.delete('/admin/promo/pill-image', adminAuth, async (_req, res) => {
  try {
    await pool.query(
      `UPDATE app_home_promo
          SET pill_image_data = NULL, pill_image_mime = NULL,
              revision = revision + 1, updated_at = now()
        WHERE id = 1`,
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/promo/pill-image:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
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

/* --- Borrado de la cuenta del cliente desde la app (App Store 5.1.1(v)) --- */

// Elimina todos los datos del cliente en este backend (lista de deseos, notas
// de cata) y desvincula sus dispositivos de notificaciones. Registra la
// solicitud para que Mario pueda eliminar después el cliente de Shopify a mano.
// El borrado del cliente en Shopify NO se hace aquí.
app.delete('/me/account', auth, async (req, res) => {
  const customerId = req.customerId;
  try {
    await pool.query('DELETE FROM app_wishlist WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM app_tasting_notes WHERE customer_id = $1', [customerId]);
    await pool.query('UPDATE app_push_tokens SET customer_id = NULL WHERE customer_id = $1', [customerId]);
    await pool.query(
      `INSERT INTO app_account_deletions (customer_id) VALUES ($1)
         ON CONFLICT (customer_id) DO UPDATE SET requested_at = now()`,
      [customerId],
    );
    // Invalida la caché del token para que cualquier petición posterior con
    // este token tenga que revalidarlo contra Shopify.
    const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (token) tokenCache.delete(token);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /me/account:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/* --- Errores --- */

app.use((err, _req, res, _next) => {
  console.error('Error no controlado:', err);
  res.status(500).json({ error: 'server_error' });
});

const PORT = process.env.PORT || 3000;
initDb();
app.listen(PORT, () => console.log(`Backend de Aromas de Té escuchando en :${PORT}`));
