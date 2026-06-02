/**
 * Autenticación del panel de administración.
 *
 * - Hash de contraseñas con `crypto.scrypt` nativo (sin dependencias externas).
 * - Sesiones por cookie firmada HMAC-SHA256 (HttpOnly, Secure, SameSite=Strict).
 * - Bootstrap: si no hay ningún usuario en BD, se crea uno desde ADMIN_USER /
 *   ADMIN_PASSWORD del .env la primera vez que se valida un login con esos
 *   credenciales. Así el panel sigue accesible aunque se vacíe la tabla.
 * - Rate limit en /admin/login: 5 intentos fallidos por IP en 10 minutos.
 */
import {
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// ---------- Hashing ----------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

/** Genera un hash en formato "scrypt$N=...,r=...,p=...$<salt-hex>$<hash-hex>". */
export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 10) {
    throw new Error('password_too_short');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Verifica una contraseña contra un hash en el formato de `hashPassword`. */
export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const params = Object.fromEntries(
    parts[1].split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, Number(v)];
    }),
  );
  if (!params.N || !params.r || !params.p) return false;
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  let derived;
  try {
    derived = await scrypt(plain, salt, expected.length, {
      N: params.N, r: params.r, p: params.p,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// ---------- Cookies de sesión ----------

// Secreto para firmar las cookies. Si no se define, se genera al arrancar
// (lo que invalida sesiones anteriores tras un redeploy — aceptable).
const SESSION_SECRET =
  process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const COOKIE_NAME = 'aromas_admin_sid';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Construye una cookie firmada con el payload del usuario. */
export function signSession(payload) {
  const data = { ...payload, exp: Date.now() + SESSION_TTL_MS };
  const body = base64url(JSON.stringify(data));
  const sig = createHmac('sha256', SESSION_SECRET).update(body).digest();
  return `${body}.${base64url(sig)}`;
}

/** Valida y devuelve el payload, o null si caducó/no es válida. */
export function verifySession(value) {
  if (!value || typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac('sha256', SESSION_SECRET).update(body).digest();
  const got = fromBase64url(sig);
  if (got.length !== expected.length) return null;
  if (!timingSafeEqual(got, expected)) return null;
  try {
    const payload = JSON.parse(fromBase64url(body).toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Cabecera Set-Cookie para crear o limpiar la cookie. `secure` solo se
 *  emite cuando la petición vino por HTTPS (en local sin TLS se omite, así
 *  el navegador la guarda igual). */
export function buildSetCookie(value, { clear = false, secure = true } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) attrs.push('Secure');
  if (clear) attrs.push('Max-Age=0');
  else attrs.push(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  return attrs.join('; ');
}

/** Detecta si la petición llegó por HTTPS (respetando X-Forwarded-Proto del
 *  proxy de easypanel). En local sin TLS devuelve false. */
export function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  return false;
}

/** Lee la cookie de sesión del request. */
export function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === COOKIE_NAME) {
      return part.slice(eq + 1);
    }
  }
  return null;
}

// ---------- Bootstrap inicial ----------

/**
 * Si la tabla de usuarios está vacía y hay ADMIN_USER+ADMIN_PASSWORD en el
 * .env, crea ese usuario como admin. Idempotente.
 */
export async function bootstrapAdminUser(pool) {
  const envUser = process.env.ADMIN_USER;
  const envPass = process.env.ADMIN_PASSWORD;
  if (!envUser || !envPass) return;
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM app_admin_users');
    if (rows[0]?.n > 0) return;
    // Si la contraseña del .env es < 10 chars, la aceptamos igual para no
    // dejar el panel sin acceso: el usuario podrá cambiarla desde dentro.
    const hash = await hashPasswordRelaxed(envPass);
    await pool.query(
      `INSERT INTO app_admin_users (username, password_hash, role)
         VALUES ($1, $2, 'admin')
         ON CONFLICT (username) DO NOTHING`,
      [envUser, hash],
    );
    console.log(`Usuario admin bootstrapeado desde .env: ${envUser}`);
  } catch (err) {
    console.error('bootstrapAdminUser:', err.message);
  }
}

// Variante de hash que NO valida longitud mínima (solo para bootstrap).
async function hashPasswordRelaxed(plain) {
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

// ---------- Rate limit de login ----------

const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const RATE_MAX_FAILS = 5;

/** ¿La IP está bloqueada por demasiados intentos fallidos recientes? */
export async function isLoginBlocked(pool, ip) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM app_admin_login_attempts
        WHERE ip = $1 AND success = false
          AND attempted_at > now() - ($2 || ' milliseconds')::interval`,
      [ip, String(RATE_WINDOW_MS)],
    );
    return (rows[0]?.n || 0) >= RATE_MAX_FAILS;
  } catch {
    return false;
  }
}

export async function recordLoginAttempt(pool, ip, success, username) {
  try {
    await pool.query(
      `INSERT INTO app_admin_login_attempts (ip, success, username)
         VALUES ($1, $2, $3)`,
      [ip, !!success, username || null],
    );
    // Purga oportunista de intentos > 24h.
    await pool.query(
      `DELETE FROM app_admin_login_attempts
        WHERE attempted_at < now() - interval '24 hours'`,
    );
  } catch (err) {
    console.error('recordLoginAttempt:', err.message);
  }
}

// IP del cliente respetando el proxy de easypanel (X-Forwarded-For).
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
