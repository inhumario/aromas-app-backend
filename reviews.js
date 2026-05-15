/**
 * Valoraciones de producto de Trusted Shops (eTrusted).
 *
 * Trae todas las reseñas de producto aprobadas, las agrupa por producto de
 * Shopify (usando el handle que viene en `product.url`) y cachea el resultado.
 * El secreto de eTrusted vive solo aquí, en el servidor — nunca en la app.
 */
const TS = {
  clientId: process.env.TS_CLIENT_ID,
  clientSecret: process.env.TS_CLIENT_SECRET,
  oauthUrl: process.env.TS_OAUTH_URL || 'https://login.etrusted.com/oauth/token',
  audience: process.env.TS_AUDIENCE || 'https://api.etrusted.com',
  apiBase: process.env.TS_API_BASE || 'https://api.etrusted.com',
};

const TTL_MS = 6 * 60 * 60 * 1000; // refresco cada 6 h
let cache = { at: 0, byHandle: {} };
let refreshing = null;

function configured() {
  return !!(TS.clientId && TS.clientSecret);
}

function handleFromUrl(url) {
  const m = /\/products\/([^/?#]+)/.exec(url || '');
  return m ? decodeURIComponent(m[1]) : null;
}

async function getToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: TS.clientId,
    client_secret: TS.clientSecret,
    audience: TS.audience,
  });
  const res = await fetch(TS.oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`etrusted auth ${res.status}`);
  return (await res.json()).access_token;
}

async function refresh() {
  const token = await getToken();
  const byHandle = {};
  let url = `${TS.apiBase}/reviews?type=PRODUCT_REVIEW&status=APPROVED&count=100`;
  let guard = 0;

  while (url && guard++ < 80) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const data = await res.json();
    const items = data.items || [];
    if (items.length === 0) break;

    for (const it of items) {
      const handle = handleFromUrl(it.product?.url);
      if (!handle) continue;
      const e = byHandle[handle] || (byHandle[handle] = { sum: 0, count: 0, items: [] });
      e.sum += it.rating || 0;
      e.count += 1;
      if (e.items.length < 6 && it.comment) {
        e.items.push({
          rating: it.rating,
          title: it.title || null,
          comment: it.comment,
          author: it.customer?.firstName || 'Cliente',
          date: it.submittedAt,
        });
      }
    }
    url = data.paging?.links?.next || null;
  }

  cache = { at: Date.now(), byHandle };
}

/** Asegura que la caché está fresca (refresco perezoso). */
async function ensureFresh() {
  if (Date.now() - cache.at <= TTL_MS) return;
  if (!refreshing) {
    refreshing = refresh()
      .catch((err) => console.error('reviews refresh:', err.message))
      .finally(() => {
        refreshing = null;
      });
  }
  // La primera vez (caché vacía) se espera; si ya hay datos, se sirve lo viejo.
  if (cache.at === 0) await refreshing;
}

/** Valoración agregada de un producto por su handle de Shopify. */
export async function getReviewsForHandle(handle) {
  const empty = { handle, rating: null, count: 0, items: [] };
  if (!configured()) return empty;
  await ensureFresh();
  const e = cache.byHandle[handle];
  if (!e || e.count === 0) return empty;
  return {
    handle,
    rating: Math.round((e.sum / e.count) * 10) / 10,
    count: e.count,
    items: e.items,
  };
}

/** Nota media y nº de reseñas de TODOS los productos: { handle: { rating, count } }. */
export async function getAllRatings() {
  if (!configured()) return {};
  await ensureFresh();
  const out = {};
  for (const [handle, e] of Object.entries(cache.byHandle)) {
    if (e.count > 0) {
      out[handle] = { rating: Math.round((e.sum / e.count) * 10) / 10, count: e.count };
    }
  }
  return out;
}
