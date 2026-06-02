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
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import pg from 'pg';
import { getAllRatings, getReviewsForHandle } from './reviews.js';
import { recordNotification, sendPush } from './push.js';
import { handleOrderWebhook, verifyShopifyHmac } from './webhooks.js';
import {
  bootstrapAdminUser,
  buildSetCookie,
  clientIp,
  hashPassword,
  isLoginBlocked,
  isSecureRequest,
  isValidEmail,
  randomToken,
  readCookie,
  recordLoginAttempt,
  signSession,
  verifyPassword,
  verifySession,
} from './auth.js';
import { sendEmail } from './mailer.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

const CUSTOMER_API =
  process.env.SHOPIFY_CUSTOMER_API ||
  'https://shopify.com/79280144711/account/customer/api/2025-01/graphql';

const PANEL_HTML_RAW = readFileSync(new URL('./panel.html', import.meta.url), 'utf8');

// URL pública del backend, para construir el enlace de la imagen del popup.
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://app-api.aromasdete.com';

/* --------------------------- Versión del panel ----------------------- */

// Identificador único de cada despliegue. Se calcula al arrancar a partir
// del hash del HTML del panel + el código del servidor; cualquier cambio
// en uno u otro genera un BUILD_ID distinto, así Mario (y nosotros) ve en
// la cabecera del panel exactamente qué versión está cargada y puede
// comparar contra la que acaba de desplegarse. Sin necesidad de mantener
// un número de versión a mano.
function computeBuildId() {
  try {
    const h = createHash('sha256');
    for (const file of ['./panel.html', './server.js', './auth.js']) {
      try { h.update(readFileSync(new URL(file, import.meta.url))); } catch {}
    }
    return h.digest('hex').slice(0, 8);
  } catch {
    return 'unknown';
  }
}
function startedAt() {
  try {
    // Mtime del fichero más reciente: aproxima la fecha del despliegue
    // (el contenedor se acaba de construir con esos archivos).
    let max = 0;
    for (const file of ['./panel.html', './server.js']) {
      try { max = Math.max(max, statSync(new URL(file, import.meta.url)).mtimeMs); } catch {}
    }
    return max ? new Date(max).toISOString() : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}
const BUILD_ID = computeBuildId();
const BUILD_DATE = startedAt();
console.log(`Build ${BUILD_ID} (${BUILD_DATE})`);

// El HTML del panel sin tocar se sirve siempre; al servirlo, sustituyo el
// placeholder ${BUILD_VERSION} (si existe) por la cadena calculada arriba.
const PANEL_HTML = PANEL_HTML_RAW
  .replace(/__BUILD_ID__/g, BUILD_ID)
  .replace(/__BUILD_DATE__/g, BUILD_DATE);

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

// token -> { customer: { id, email }, expiresAt }
const tokenCache = new Map();

/** Verifica el token de cliente contra la Customer Account API de Shopify
 *  y devuelve `{id, email}`. Devuelve null si el token no es válido. */
async function resolveCustomer(token) {
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.customer;

  const res = await fetch(CUSTOMER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({
      query: '{ customer { id emailAddress { emailAddress } } }',
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const id = json?.data?.customer?.id ?? null;
  if (!id) return null;
  const email = json?.data?.customer?.emailAddress?.emailAddress || null;
  const customer = { id, email };
  tokenCache.set(token, { customer, expiresAt: Date.now() + 5 * 60_000 });
  return customer;
}

// Compat: rutas viejas que solo querían el id. Pone email a null si solo
// se pidió por id.
async function resolveCustomerId(token) {
  const c = await resolveCustomer(token);
  return c?.id ?? null;
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

/**
 * Autenticación del panel. Se basa en una cookie de sesión firmada (HMAC) que
 * se emite tras un POST a /admin/login. El payload guarda { uid, username,
 * role, exp }. La cookie es HttpOnly + Secure + SameSite=Strict.
 *
 * Si la cookie no es válida y el cliente acepta HTML, devolvemos la pantalla
 * de login del propio panel. Para llamadas a la API admin (JSON) devolvemos
 * 401 con `{error:'unauthorized'}` para que el panel pueda redirigir al login.
 */
async function loadUser(req) {
  const session = verifySession(readCookie(req));
  if (!session?.uid) return null;
  const { rows } = await pool.query(
    'SELECT id, username, role, enabled, email FROM app_admin_users WHERE id = $1',
    [session.uid],
  );
  const u = rows[0];
  if (!u || !u.enabled) return null;
  return { id: Number(u.id), username: u.username, role: u.role, email: u.email };
}

function adminAuth(opts = {}) {
  const requireAdmin = !!opts.requireAdmin;
  return async function (req, res, next) {
    let user;
    try {
      user = await loadUser(req);
    } catch (err) {
      console.error('adminAuth:', err.message);
      return res.status(500).json({ error: 'server_error' });
    }
    if (!user) {
      // Para llamadas JSON, 401; para navegación HTML, mandamos el login.
      if (req.accepts(['json', 'html']) === 'html') {
        return res.type('html').send(PANEL_HTML);
      }
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (requireAdmin && user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }
    req.user = user;
    next();
  };
}

/* -------------------- Contenido editable del inicio ------------------ */

// Columnas de `app_home_promo` que se devuelven a la app/panel. NO incluye
// `popup_image_data` (el binario de la imagen, que puede pesar): se sirve
// aparte en GET /home/promo/image. `has_image` indica si hay imagen subida.
const PROMO_COLS = `id, pill_enabled, pill_emoji, pill_label, pill_text,
  popup_enabled, popup_title, popup_body, popup_image,
  link, pill_link, popup_link, cta_label,
  revision, updated_at, popup_cooldown_hours,
  pill_starts_at, pill_ends_at, popup_starts_at, popup_ends_at,
  (popup_image_data IS NOT NULL) AS has_image,
  (pill_image_data IS NOT NULL) AS has_pill_image`;

/** ¿Estamos dentro de la ventana [startsAt, endsAt]? NULL en cada extremo
 *  significa "sin límite por ese lado". */
function withinWindow(startsAt, endsAt) {
  const now = Date.now();
  if (startsAt && now < new Date(startsAt).getTime()) return false;
  if (endsAt && now > new Date(endsAt).getTime()) return false;
  return true;
}

/** Normaliza un texto del formulario: vacío o no-texto -> null. */
function cleanText(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length ? s : null;
}

/**
 * Devuelve una revisión "efectiva" para que el popup se repita cada X horas.
 * Se usa solo en la respuesta pública: hacemos pasar al cliente una revisión
 * distinta cada cierto tiempo (un "bucket") aunque la promo no haya cambiado.
 * Así las versiones de la app ya publicadas (que solo comparan revisiones)
 * vuelven a mostrar el popup sin necesidad de actualizar el código.
 */
function effectiveRevision(row) {
  const cooldown = Number(row.popup_cooldown_hours) || 0;
  if (cooldown <= 0) return row.revision;
  const updated = row.updated_at ? new Date(row.updated_at).getTime() : Date.now();
  const elapsedHours = (Date.now() - updated) / 3600000;
  if (elapsedHours <= cooldown) return row.revision;
  const bucket = Math.floor(elapsedHours / cooldown);
  // Mezcla `revision` con el `bucket` en un entero estable y único.
  return row.revision * 100000 + bucket;
}

/**
 * Fila `app_home_promo` -> objeto JSON con claves camelCase. `forApp` aplica
 * el cooldown del popup sobre la revisión; el panel debe llamarla con `false`
 * para ver la revisión real.
 */
function promoToJson(row, forApp = true) {
  if (!row) {
    return {
      pillEnabled: false, pillEmoji: null, pillLabel: null, pillText: null,
      pillImage: null, pillStartsAt: null, pillEndsAt: null,
      popupEnabled: false, popupTitle: null, popupBody: null, popupImage: null,
      popupStartsAt: null, popupEndsAt: null,
      link: null, pillLink: null, popupLink: null,
      ctaLabel: null, revision: 0, popupCooldownHours: null, updatedAt: null,
    };
  }
  // `pill_link`/`popup_link` se introdujeron después de `link`. Si están
  // vacíos, se cae al `link` viejo para compatibilidad. `link` se mantiene
  // en la respuesta para que versiones de la app anteriores (que solo lo
  // conocían a él) sigan funcionando con el destino más visible.
  const pillLink = row.pill_link ?? row.link ?? null;
  const popupLink = row.popup_link ?? row.link ?? null;
  // Para la app, los flags `pillEnabled` y `popupEnabled` ya vienen filtrados
  // por la ventana de programación; para el panel, se devuelve el valor
  // bruto del switch (forApp=false).
  const pillEnabledFlag = !!row.pill_enabled;
  const popupEnabledFlag = !!row.popup_enabled;
  const pillEffective = pillEnabledFlag &&
    (!forApp || withinWindow(row.pill_starts_at, row.pill_ends_at));
  const popupEffective = popupEnabledFlag &&
    (!forApp || withinWindow(row.popup_starts_at, row.popup_ends_at));
  return {
    pillEnabled: pillEffective,
    pillEmoji: row.pill_emoji,
    pillLabel: row.pill_label,
    pillText: row.pill_text,
    // Imagen opcional de la pastilla; se sirve aparte como la del popup.
    pillImage: row.has_pill_image
      ? `${PUBLIC_BASE}/home/promo/pill-image?v=${row.revision}`
      : null,
    pillStartsAt: row.pill_starts_at,
    pillEndsAt: row.pill_ends_at,
    popupEnabled: popupEffective,
    popupTitle: row.popup_title,
    popupBody: row.popup_body,
    // Imagen subida desde el panel; si no hay, la URL externa (campo antiguo).
    // El `?v=` con la revisión refresca la caché cuando la imagen cambia.
    popupImage: row.has_image
      ? `${PUBLIC_BASE}/home/promo/image?v=${row.revision}`
      : row.popup_image || null,
    popupStartsAt: row.popup_starts_at,
    popupEndsAt: row.popup_ends_at,
    link: row.link ?? pillLink,
    pillLink,
    popupLink,
    ctaLabel: row.cta_label,
    revision: forApp ? effectiveRevision(row) : row.revision,
    popupCooldownHours: row.popup_cooldown_hours ?? null,
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

app.get('/health', (_req, res) => res.json({ ok: true, service: 'aromas-app-backend', build: BUILD_ID }));

// Versión del panel (la usa el propio panel para mostrarla en la cabecera
// y para detectar si el servidor ha redespeguado con código nuevo).
app.get('/admin/version', (_req, res) => {
  res.json({ build: BUILD_ID, date: BUILD_DATE });
});

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
  // Si la app envía el token de cliente, el dispositivo queda asociado a
  // su cuenta (customer_id) y a su email para recibir en el buzón los
  // avisos de sus pedidos. El email permite localizar al dispositivo aun
  // cuando el pedido se hizo desde la web con otra cuenta del mismo
  // correo.
  let customerId = null;
  let email = null;
  const authToken = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (authToken) {
    try {
      const c = await resolveCustomer(authToken);
      if (c) { customerId = c.id; email = c.email; }
    } catch {
      customerId = null; email = null;
    }
  }
  // ON CONFLICT (token): si el cliente no está logado ahora (customerId/
  // email null) pero antes sí lo estaba, NO pisamos lo que ya había
  // guardado. Así mantenemos la asociación cliente↔dispositivo cuando el
  // token de sesión caduca y el dispositivo solo se renueva el push.
  await pool.query(
    `INSERT INTO app_push_tokens (token, platform, prefs, customer_id, email, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (token)
       DO UPDATE SET
         platform    = $2,
         prefs       = $3,
         customer_id = COALESCE($4, app_push_tokens.customer_id),
         email       = COALESCE($5, app_push_tokens.email),
         updated_at  = now()`,
    [token, platform ?? null, JSON.stringify(prefs ?? {}), customerId, email],
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

// La página del panel se sirve siempre (sin auth). El propio HTML detecta si
// hay sesión consultando GET /admin/me y muestra la pantalla de login si no.
app.get('/admin', (_req, res) => {
  res.type('html').send(PANEL_HTML);
});

// Alias para el enlace de recuperación que llega por email: sirve el mismo
// HTML y el panel detecta el `?token=` en JS para mostrar el form de reset.
app.get('/admin/reset', (_req, res) => {
  res.type('html').send(PANEL_HTML);
});

/* --- Sesión: login / logout / quién soy --- */

app.post('/admin/login', async (req, res) => {
  const ip = clientIp(req);
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string'
      || !username.trim() || !password) {
    return res.status(400).json({ error: 'credentials_required' });
  }
  if (await isLoginBlocked(pool, ip)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, username, password_hash, role, enabled
         FROM app_admin_users
        WHERE lower(username) = lower($1)`,
      [username.trim()],
    );
    const u = rows[0];
    const ok = !!u && u.enabled && (await verifyPassword(password, u.password_hash));
    await recordLoginAttempt(pool, ip, ok, username.trim());
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    await pool.query(
      'UPDATE app_admin_users SET last_login_at = now() WHERE id = $1',
      [u.id],
    );
    const uid = Number(u.id);
    const cookie = signSession({ uid, username: u.username, role: u.role });
    res.set('Set-Cookie', buildSetCookie(cookie, { secure: isSecureRequest(req) }));
    res.json({ ok: true, user: { id: uid, username: u.username, role: u.role } });
  } catch (err) {
    console.error('POST /admin/login:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/admin/logout', (req, res) => {
  res.set('Set-Cookie', buildSetCookie('', { clear: true, secure: isSecureRequest(req) }));
  res.json({ ok: true });
});

/* --- Recuperación de contraseña por email --- */

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hora

// Solicitud de recuperación. Siempre devuelve `{ok:true}` aunque el email no
// exista en la BD: evita filtrar qué emails están registrados. El rate-limit
// del login también se aplica aquí (mismas tablas) para frenar abusos.
app.post('/admin/forgot-password', async (req, res) => {
  const ip = clientIp(req);
  const { email } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  if (await isLoginBlocked(pool, ip)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, username, email FROM app_admin_users
        WHERE lower(email) = lower($1) AND enabled = true`,
      [email.trim()],
    );
    const u = rows[0];
    // Registra el intento (success=false; los exitosos solo se cuentan al
    // resetear). Esto contribuye al rate-limit por IP.
    await recordLoginAttempt(pool, ip, !!u, email.trim());
    if (u) {
      const token = randomToken();
      await pool.query(
        `INSERT INTO app_admin_password_resets (token, user_id, expires_at)
           VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
        [token, u.id, String(RESET_TTL_MS)],
      );
      const link = `${PUBLIC_BASE}/admin/reset?token=${token}`;
      const body =
        `Hola ${u.username},\n\n` +
        `Hemos recibido una solicitud para cambiar la contraseña de tu cuenta del panel de Aromas de Té.\n\n` +
        `Para definir una nueva contraseña, abre este enlace (caduca en 1 hora):\n\n${link}\n\n` +
        `Si no has sido tú, ignora este correo: tu contraseña actual seguirá siendo válida.\n\n` +
        `— Panel de Aromas de Té`;
      // No bloqueamos la respuesta esperando al SMTP: si el envío falla,
      // queda un log y el usuario puede volver a intentarlo.
      sendEmail({
        to: u.email,
        subject: 'Recuperar contraseña del panel — Aromas de Té',
        text: body,
      }).catch((err) => console.error('sendEmail reset:', err.message));
    }
    // Respuesta neutra para no revelar si el email existe.
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /admin/forgot-password:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Verifica si un token de reset sigue siendo válido (sin gastarlo). La UI
// lo llama al cargar la pantalla de "establecer nueva contraseña" para
// avisar antes de que el usuario escriba si el enlace caducó.
app.get('/admin/reset-password/check', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.json({ valid: false });
  try {
    const { rows } = await pool.query(
      `SELECT r.expires_at, r.used_at, u.username, u.enabled
         FROM app_admin_password_resets r
         JOIN app_admin_users u ON u.id = r.user_id
        WHERE r.token = $1`,
      [token],
    );
    const r = rows[0];
    const valid = !!r && !r.used_at && new Date(r.expires_at) >= new Date() && r.enabled;
    res.json({ valid, username: valid ? r.username : null });
  } catch (err) {
    console.error('GET /admin/reset-password/check:', err.message);
    res.json({ valid: false });
  }
});

// Reseteo: el cliente envía `{token, newPassword}`. Si el token es válido y
// no ha caducado ni se ha usado, fija la nueva contraseña.
app.post('/admin/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof token !== 'string' || token.length < 32) {
    return res.status(400).json({ error: 'invalid_token' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 10) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT r.token, r.user_id, r.expires_at, r.used_at,
              u.username, u.enabled
         FROM app_admin_password_resets r
         JOIN app_admin_users u ON u.id = r.user_id
        WHERE r.token = $1`,
      [token],
    );
    const r = rows[0];
    if (!r || r.used_at || new Date(r.expires_at) < new Date() || !r.enabled) {
      return res.status(400).json({ error: 'invalid_or_expired' });
    }
    const hash = await hashPassword(newPassword);
    await pool.query(
      'UPDATE app_admin_users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [hash, r.user_id],
    );
    await pool.query(
      'UPDATE app_admin_password_resets SET used_at = now() WHERE token = $1',
      [token],
    );
    // Purga oportunista de tokens caducados/usados de más de 7 días.
    await pool.query(
      `DELETE FROM app_admin_password_resets
        WHERE expires_at < now() - interval '7 days'`,
    );
    res.json({ ok: true, username: r.username });
  } catch (err) {
    console.error('POST /admin/reset-password:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/admin/me', adminAuth(), (req, res) => {
  res.json({ user: req.user });
});

// Cambia el email del usuario logado. Se usa para la recuperación de
// contraseña, así que es importante que sea uno al que el usuario tenga
// acceso real. Permite borrarlo enviando `null`.
app.post('/admin/me/email', adminAuth(), async (req, res) => {
  const { email } = req.body || {};
  let value = null;
  if (email !== null && email !== '' && email !== undefined) {
    if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    value = email.trim();
  }
  try {
    await pool.query(
      'UPDATE app_admin_users SET email = $1, updated_at = now() WHERE id = $2',
      [value, req.user.id],
    );
    res.json({ ok: true, email: value });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_taken' });
    console.error('POST /admin/me/email:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Cambiar la contraseña del usuario logado. Pide la actual para evitar
// que alguien con la sesión secuestrada la cambie sin más.
app.post('/admin/me/password', adminAuth(), async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'passwords_required' });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ error: 'new_password_too_short' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT password_hash FROM app_admin_users WHERE id = $1',
      [req.user.id],
    );
    if (!rows[0]) return res.status(401).json({ error: 'unauthorized' });
    if (!(await verifyPassword(currentPassword, rows[0].password_hash))) {
      return res.status(401).json({ error: 'invalid_current_password' });
    }
    const hash = await hashPassword(newPassword);
    await pool.query(
      'UPDATE app_admin_users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [hash, req.user.id],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /admin/me/password:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/* --- Gestión de usuarios (solo rol admin) --- */

function publicUser(u) {
  return {
    id: Number(u.id),
    username: u.username,
    email: u.email || null,
    role: u.role,
    enabled: u.enabled,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    lastLoginAt: u.last_login_at,
  };
}

function validUsername(s) {
  return typeof s === 'string' && /^[A-Za-z0-9._-]{3,40}$/.test(s);
}
function validRole(s) { return s === 'admin' || s === 'editor'; }

app.get('/admin/users', adminAuth({ requireAdmin: true }), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, email, role, enabled, created_at, updated_at, last_login_at
         FROM app_admin_users ORDER BY username`,
    );
    res.json({ items: rows.map(publicUser) });
  } catch (err) {
    console.error('GET /admin/users:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/admin/users', adminAuth({ requireAdmin: true }), async (req, res) => {
  const { username, password, role, email } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: 'invalid_username' });
  if (!validRole(role)) return res.status(400).json({ error: 'invalid_role' });
  if (typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  let emailValue = null;
  if (email) {
    if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    emailValue = email.trim();
  }
  try {
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO app_admin_users (username, password_hash, role, email, created_by)
         VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, role, enabled, created_at, updated_at, last_login_at`,
      [username.trim(), hash, role, emailValue, req.user.id],
    );
    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    if (err.code === '23505') {
      // Distinguir por la constraint que falló (username vs email).
      const which = /email/i.test(err.constraint || err.detail || '') ? 'email_taken' : 'username_taken';
      return res.status(409).json({ error: which });
    }
    console.error('POST /admin/users:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.patch('/admin/users/:id', adminAuth({ requireAdmin: true }), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  const { role, enabled, newPassword, email } = req.body || {};
  const sets = [];
  const params = [];
  if (role !== undefined) {
    if (!validRole(role)) return res.status(400).json({ error: 'invalid_role' });
    // No permitir quitarse el rol admin a uno mismo (evita lockout).
    if (id === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'cannot_demote_self' });
    }
    params.push(role); sets.push(`role = $${params.length}`);
  }
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'invalid_enabled' });
    if (id === req.user.id && enabled === false) {
      return res.status(400).json({ error: 'cannot_disable_self' });
    }
    params.push(enabled); sets.push(`enabled = $${params.length}`);
  }
  if (newPassword !== undefined) {
    if (typeof newPassword !== 'string' || newPassword.length < 10) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    const hash = await hashPassword(newPassword);
    params.push(hash); sets.push(`password_hash = $${params.length}`);
  }
  if (email !== undefined) {
    let v = null;
    if (email !== null && email !== '') {
      if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });
      v = String(email).trim();
    }
    params.push(v); sets.push(`email = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  sets.push('updated_at = now()');
  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE app_admin_users SET ${sets.join(', ')} WHERE id = $${params.length}
         RETURNING id, username, email, role, enabled, created_at, updated_at, last_login_at`,
      params,
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_taken' });
    console.error('PATCH /admin/users:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/admin/users/:id', adminAuth({ requireAdmin: true }), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  if (id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  try {
    // Si era el último admin, bloqueamos el borrado para no perder el acceso.
    const { rows: admins } = await pool.query(
      `SELECT id FROM app_admin_users WHERE role = 'admin' AND enabled = true`,
    );
    if (admins.length <= 1 && admins.some((a) => Number(a.id) === id)) {
      return res.status(400).json({ error: 'last_admin' });
    }
    const r = await pool.query('DELETE FROM app_admin_users WHERE id = $1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/users:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/admin/push', adminAuth(), async (req, res) => {
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
// `forApp:false` para que el panel vea la revisión real, no la "rotada" por
// el cooldown que se sirve a la app.
app.get('/admin/promo', adminAuth(), async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${PROMO_COLS} FROM app_home_promo WHERE id = 1`);
    res.json(promoToJson(rows[0], false));
  } catch (err) {
    console.error('GET /admin/promo:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Contenido editable del inicio: guardar. `revision` sube en cada guardado
// para que el popup vuelva a aparecer una vez a quien ya lo había visto.
// La imagen del popup se sube aparte (POST /admin/promo/image).
/** Parsea ISO/datetime-local del panel a Date|null. Vacío -> null. */
function parseDateOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Recalcula el campo `link` legacy a partir de pill_link/popup_link de BD. */
async function syncLegacyLink() {
  await pool.query(
    `UPDATE app_home_promo SET link = COALESCE(pill_link, popup_link, link) WHERE id = 1`,
  );
}

// Guarda SOLO los campos de la pastilla de ofertas.
app.post('/admin/promo/pill', adminAuth(), async (req, res) => {
  const b = req.body || {};
  const pillLink = cleanText(b.pillLink);
  try {
    const { rows } = await pool.query(
      `UPDATE app_home_promo SET
         pill_enabled = $1, pill_emoji = $2, pill_label = $3, pill_text = $4,
         pill_link = $5, pill_starts_at = $6, pill_ends_at = $7,
         revision = revision + 1, updated_at = now()
       WHERE id = 1
       RETURNING ${PROMO_COLS}`,
      [
        !!b.pillEnabled, cleanText(b.pillEmoji), cleanText(b.pillLabel), cleanText(b.pillText),
        pillLink, parseDateOrNull(b.pillStartsAt), parseDateOrNull(b.pillEndsAt),
      ],
    );
    await syncLegacyLink();
    res.json(promoToJson(rows[0], false));
  } catch (err) {
    console.error('POST /admin/promo/pill:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Guarda SOLO los campos del popup de bienvenida.
app.post('/admin/promo/popup', adminAuth(), async (req, res) => {
  const b = req.body || {};
  const popupLink = cleanText(b.popupLink);
  let cooldown = null;
  if (b.popupCooldownHours != null && b.popupCooldownHours !== '') {
    const n = Number(b.popupCooldownHours);
    if (Number.isFinite(n) && n >= 0) cooldown = Math.floor(n);
  }
  try {
    const { rows } = await pool.query(
      `UPDATE app_home_promo SET
         popup_enabled = $1, popup_title = $2, popup_body = $3,
         popup_link = $4, cta_label = $5, popup_cooldown_hours = $6,
         popup_starts_at = $7, popup_ends_at = $8,
         revision = revision + 1, updated_at = now()
       WHERE id = 1
       RETURNING ${PROMO_COLS}`,
      [
        !!b.popupEnabled, cleanText(b.popupTitle), cleanText(b.popupBody),
        popupLink, cleanText(b.ctaLabel), cooldown,
        parseDateOrNull(b.popupStartsAt), parseDateOrNull(b.popupEndsAt),
      ],
    );
    await syncLegacyLink();
    res.json(promoToJson(rows[0], false));
  } catch (err) {
    console.error('POST /admin/promo/popup:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Endpoint legacy (compat): guarda ambos a la vez. El panel nuevo ya no lo
// usa, pero se mantiene por si algo lo invocara.
app.post('/admin/promo', adminAuth(), async (req, res) => {
  const b = req.body || {};
  const pillLink = cleanText(b.pillLink);
  const popupLink = cleanText(b.popupLink);
  const legacyLink = pillLink ?? popupLink ?? cleanText(b.link);
  let cooldown = null;
  if (b.popupCooldownHours != null && b.popupCooldownHours !== '') {
    const n = Number(b.popupCooldownHours);
    if (Number.isFinite(n) && n >= 0) cooldown = Math.floor(n);
  }
  try {
    const { rows } = await pool.query(
      `UPDATE app_home_promo SET
         pill_enabled = $1, pill_emoji = $2, pill_label = $3, pill_text = $4,
         popup_enabled = $5, popup_title = $6, popup_body = $7,
         link = $8, pill_link = $9, popup_link = $10, cta_label = $11,
         popup_cooldown_hours = $12,
         revision = revision + 1, updated_at = now()
       WHERE id = 1
       RETURNING ${PROMO_COLS}`,
      [
        !!b.pillEnabled, cleanText(b.pillEmoji), cleanText(b.pillLabel), cleanText(b.pillText),
        !!b.popupEnabled, cleanText(b.popupTitle), cleanText(b.popupBody),
        legacyLink, pillLink, popupLink, cleanText(b.ctaLabel),
        cooldown,
      ],
    );
    res.json(promoToJson(rows[0], false));
  } catch (err) {
    console.error('POST /admin/promo:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Subir la imagen del popup. El cuerpo es el fichero en crudo y el Content-Type
// indica el tipo. Sube `revision` para que la app refresque la imagen.
app.post(
  '/admin/promo/image',
  adminAuth(),
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
app.delete('/admin/promo/image', adminAuth(), async (_req, res) => {
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
  adminAuth(),
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

app.delete('/admin/promo/pill-image', adminAuth(), async (_req, res) => {
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
app.get('/admin/notifications', adminAuth(), async (_req, res) => {
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
// `trust proxy` para que `clientIp()` lea X-Forwarded-For del proxy de easypanel.
app.set('trust proxy', true);

(async () => {
  await initDb();
  await bootstrapAdminUser(pool);
})();

app.listen(PORT, () => console.log(`Backend de Aromas de Té escuchando en :${PORT}`));
