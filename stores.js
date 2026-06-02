/**
 * Integración con las stores para sacar descargas oficiales:
 *   - App Store Connect Sales Reports (iOS)
 *   - Google Play Developer Reporting API (Android)
 *
 * Sin dependencias externas: JWT firmado con `crypto` nativo, parse de
 * TSV/CSV manual, gunzip con `zlib`. Devuelve null si falta config; un
 * objeto `{error}` si la API responde con error claro; o `{total,
 * daily}` si todo va bien.
 *
 * Variables de entorno:
 *   ASC_KEY_ID, ASC_ISSUER_ID, ASC_VENDOR_NUMBER, ASC_PRIVATE_KEY_BASE64
 *     (base64 del fichero .p8 entero, encabezado PEM incluido)
 *   GOOGLE_PLAY_PACKAGE_NAME   (paquete de la app: com.aromasdete...)
 *   GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64
 *     (base64 del JSON del service account de Google Cloud)
 */
import { createHmac, createPrivateKey, createSign, sign as cryptoSign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/* ---------------------------- App Store ---------------------------- */

function ascToken() {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyB64 = process.env.ASC_PRIVATE_KEY_BASE64;
  if (!keyId || !issuerId || !keyB64) return null;
  const pem = Buffer.from(keyB64, 'base64').toString('utf8');
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: issuerId,
    iat: now,
    exp: now + 20 * 60,
    aud: 'appstoreconnect-v1',
  }));
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey({ key: pem, format: 'pem' });
  // ES256 con la API "sign" devuelve DER; lo paso a r||s concatenados
  // (64 bytes) como exige JWT (RFC 7518).
  const der = cryptoSign(null, Buffer.from(signingInput), key);
  const raw = derToJoseEcdsa(der, 32);
  return `${signingInput}.${b64url(raw)}`;
}

/** Convierte una firma ECDSA en DER al formato JOSE (r||s con tamaño fijo). */
function derToJoseEcdsa(der, partSize) {
  // DER: 0x30 len 0x02 lenR R... 0x02 lenS S...
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;
  if (der[offset] !== 0x02) throw new Error('bad_der');
  const lenR = der[offset + 1];
  let r = der.slice(offset + 2, offset + 2 + lenR);
  offset += 2 + lenR;
  if (der[offset] !== 0x02) throw new Error('bad_der');
  const lenS = der[offset + 1];
  let s = der.slice(offset + 2, offset + 2 + lenS);
  // Recorta ceros a la izquierda
  while (r.length > partSize && r[0] === 0) r = r.slice(1);
  while (s.length > partSize && s[0] === 0) s = s.slice(1);
  // Alinea a partSize por la izquierda
  const out = Buffer.alloc(partSize * 2);
  r.copy(out, partSize - r.length);
  s.copy(out, partSize * 2 - s.length);
  return out;
}

/** Formatea un Date a YYYY-MM-DD en UTC. */
function ymd(d) {
  return d.toISOString().slice(0, 10);
}

/** Suma la columna "Units" del TSV para filas que sean primera descarga
 *  (Product Type Identifier "1" = free app first download). */
function parseSalesTsv(tsv) {
  const lines = tsv.split(/\r?\n/);
  if (lines.length < 2) return 0;
  const header = lines[0].split('\t');
  const unitsIdx = header.indexOf('Units');
  const typeIdx = header.indexOf('Product Type Identifier');
  if (unitsIdx < 0 || typeIdx < 0) return 0;
  let total = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = lines[i].split('\t');
    const type = cols[typeIdx];
    // Códigos de descarga free: "1" (iPhone first install), "1F" (free
    // family), "7" (free Apple Watch), "1T" (free first install Apple TV),
    // "F1" (familia/redownload). Para no quedarnos cortos en una primera
    // versión, contamos cualquier código que empiece por "1" o "F"
    // (descargas) y excluimos updates (codigos "7T", "8", etc. — los
    // tipos que NO son installs primarios).
    if (!type) continue;
    if (type === '1' || type === '1F' || type === '1T' || type === '1E' || type === '1EP' || type === '1EU') {
      const u = parseInt(cols[unitsIdx], 10);
      if (Number.isFinite(u)) total += u;
    }
  }
  return total;
}

/** Descargas iOS por día, últimos N días. */
export async function iosDownloads(days = 30) {
  const vendor = process.env.ASC_VENDOR_NUMBER;
  const token = ascToken();
  if (!token || !vendor) return { error: 'config_missing' };

  const today = new Date();
  const daily = [];
  let total = 0;
  // El reporte diario está disponible 24-48h después; tiramos hasta
  // hace 2 días para evitar 404 garantizados.
  for (let i = 2; i < days + 2; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const reportDate = ymd(d);
    const url = new URL('https://api.appstoreconnect.apple.com/v1/salesReports');
    url.searchParams.set('filter[frequency]', 'DAILY');
    url.searchParams.set('filter[reportType]', 'SALES');
    url.searchParams.set('filter[reportSubType]', 'SUMMARY');
    url.searchParams.set('filter[vendorNumber]', vendor);
    url.searchParams.set('filter[reportDate]', reportDate);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/a-gzip' },
      });
      if (!res.ok) {
        if (res.status === 404) { daily.push({ date: reportDate, count: 0 }); continue; }
        if (res.status === 401 || res.status === 403) {
          return { error: 'auth_failed', detail: `HTTP ${res.status}` };
        }
        daily.push({ date: reportDate, count: 0 });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      let tsv;
      try { tsv = gunzipSync(buf).toString('utf8'); }
      catch { tsv = buf.toString('utf8'); }
      const count = parseSalesTsv(tsv);
      daily.push({ date: reportDate, count });
      total += count;
    } catch (err) {
      daily.push({ date: reportDate, count: 0, error: err.message });
    }
  }
  // Orden cronológico
  daily.reverse();
  return { total, daily, days };
}

/* ---------------------------- Google Play -------------------------- */

// Token cache (los access tokens duran ~1h)
let playToken = null;

async function getPlayAccessToken() {
  if (playToken && playToken.exp > Date.now() + 60_000) return playToken.value;
  const saB64 = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64;
  if (!saB64) return null;
  let sa;
  try { sa = JSON.parse(Buffer.from(saB64, 'base64').toString('utf8')); }
  catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/playdeveloperreporting',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey({ key: sa.private_key, format: 'pem' });
  const sig = createSign('RSA-SHA256').update(signingInput).sign(key);
  const jwt = `${signingInput}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  playToken = { value: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
  return playToken.value;
}

/**
 * Descargas Android leyendo los reportes oficiales de Play Console
 * desde su bucket de Cloud Storage. Cada mes natural Google deposita
 * en `gs://pubsite_prod_<DEVELOPER_ID>/stats/installs/` varios CSV
 * (UTF-16 LE) con las descargas/uninstalls diarios.
 *
 * Resumimos la columna "Daily Device Installs" del archivo `overview`
 * (primera descarga en cada dispositivo) para los últimos N días.
 */
async function getStorageToken() {
  return getPlayAccessTokenWithScope('https://www.googleapis.com/auth/devstorage.read_only');
}

async function getPlayAccessTokenWithScope(scope) {
  const saB64 = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64;
  if (!saB64) return null;
  let sa;
  try { sa = JSON.parse(Buffer.from(saB64, 'base64').toString('utf8')); }
  catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const key = createPrivateKey({ key: sa.private_key, format: 'pem' });
  const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
  const jwt = `${header}.${payload}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) return null;
  return (await res.json()).access_token;
}

function decodeCsv(buf) {
  // Los reportes de Play vienen en UTF-16 LE con BOM.
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.slice(2).swap16().toString('utf16le');
  return buf.toString('utf8');
}

export async function androidDownloads(days = 30) {
  const pkg = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  const devId = process.env.GOOGLE_PLAY_DEVELOPER_ID;
  if (!pkg || !devId) return { error: 'config_missing' };
  const token = await getStorageToken();
  if (!token) return { error: 'config_missing' };

  const bucket = `pubsite_prod_${devId}`;
  const today = new Date();
  const limitFrom = new Date(today.getTime() - days * 86400000);
  // Calculamos los meses (YYYYMM) que cubren la ventana solicitada.
  const months = new Set();
  for (let d = new Date(limitFrom); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    months.add(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }

  const daily = [];
  let total = 0;
  for (const ym of months) {
    const file = `stats/installs/installs_${pkg}_${ym}_overview.csv`;
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(file)}?alt=media`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        // 404 es esperable para el mes en curso si aún no hay datos.
        if (res.status === 404) continue;
        if (res.status === 401 || res.status === 403) {
          return { error: 'auth_failed', detail: `HTTP ${res.status}` };
        }
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const text = decodeCsv(buf);
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) continue;
      const header = lines[0].split(',');
      const dateIdx = header.indexOf('Date');
      // "Daily Device Installs" es la métrica que mide "primer instalación
      // en un dispositivo nuevo" — equivalente a "descarga única" del día.
      const colIdx = header.indexOf('Daily Device Installs');
      if (dateIdx < 0 || colIdx < 0) continue;
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const date = cols[dateIdx];
        if (!date) continue;
        // Filtra por rango pedido (días hacia atrás desde hoy).
        const d = new Date(date + 'T00:00:00Z');
        if (d < limitFrom || d > today) continue;
        const count = parseInt(cols[colIdx], 10);
        if (Number.isFinite(count)) {
          daily.push({ date, count });
          total += count;
        }
      }
    } catch {
      /* mes problemático: lo saltamos */
    }
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));
  return { total, daily, days };
}
