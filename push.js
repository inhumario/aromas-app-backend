/**
 * Envío de notificaciones push a través del servicio de Expo.
 *
 * Selecciona los tokens cuyo dueño tiene activada la categoría indicada y les
 * envía la notificación en lotes de 100 (límite de la API de Expo).
 */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * @param {import('pg').Pool} pool
 * @param {{title:string, body:string, category?:string, data?:object}} msg
 */
export async function sendPush(pool, { title, body, category, data }) {
  // category vacío → a todos; si no, solo a quien tenga esa categoría activada
  // (o sin preferencia guardada, que se considera activada por defecto).
  const { rows } = await pool.query(
    `SELECT token FROM app_push_tokens
       WHERE $1 = '' OR COALESCE((prefs ->> $1)::boolean, true) = true`,
    [category || ''],
  );
  const tokens = rows
    .map((r) => r.token)
    .filter((t) => typeof t === 'string' && t.startsWith('ExponentPushToken'));

  let sent = 0;
  for (let i = 0; i < tokens.length; i += 100) {
    const batch = tokens.slice(i, i + 100).map((to) => ({
      to,
      title,
      body,
      sound: 'default',
      channelId: 'default',
      data: data || {},
    }));
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (res.ok) sent += batch.length;
    } catch {
      /* continúa con el resto de lotes */
    }
  }
  return { recipients: tokens.length, sent };
}

/**
 * Guarda una notificación en el historial (tabla `app_notifications`).
 * Lo lee el buzón de la app y las estadísticas del panel.
 *
 * @param {import('pg').Pool} pool
 * @param {{title:string, body:string, category?:string, data?:object,
 *          audience?:string, customerId?:string|null, recipients?:number}} msg
 * @returns {Promise<number|null>} id de la notificación guardada
 */
export async function recordNotification(
  pool,
  { title, body, category, data, audience, customerId, recipients },
) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO app_notifications (title, body, category, data, audience, customer_id, recipients)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
      [
        title,
        body,
        category || null,
        JSON.stringify(data || {}),
        audience || 'all',
        customerId || null,
        recipients ?? 0,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('recordNotification:', err.message);
    return null;
  }
}
