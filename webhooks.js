/**
 * Webhooks de Shopify — avisos automáticos del estado de los pedidos.
 *
 * Shopify llama a este backend cuando un pedido se crea, se paga, se envía o
 * se cancela. Aquí se verifica la firma, se busca al cliente y se le manda una
 * notificación push (a los dispositivos con la app y la sesión iniciada).
 */
import crypto from 'node:crypto';
import { recordNotification, sendPushToTokens } from './push.js';

/** Verifica la firma HMAC-SHA256 que Shopify envía en cada webhook. */
export function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader || !rawBody) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

/** Mensaje de notificación según el evento del pedido. */
function messageFor(topic, order) {
  const name = order.name || `#${order.order_number || ''}`;
  switch (topic) {
    case 'orders/fulfilled':
      return {
        title: 'Tu pedido va en camino 📦',
        body: `Hemos enviado tu pedido ${name}. ¡Pronto lo tendrás en casa!`,
      };
    case 'orders/paid':
    case 'orders/create':
      return {
        title: 'Pedido confirmado ✅',
        body: `Hemos recibido tu pedido ${name}. Gracias por confiar en Aromas de Té.`,
      };
    case 'orders/cancelled':
      return {
        title: 'Pedido cancelado',
        body: `Tu pedido ${name} se ha cancelado. Si tienes dudas, escríbenos.`,
      };
    default:
      return null;
  }
}

/**
 * Procesa un webhook de pedido: avisa al cliente por push y lo guarda en su buzón.
 * @param {import('pg').Pool} pool
 * @param {string} topic  cabecera X-Shopify-Topic
 * @param {object} order  cuerpo del webhook
 */
export async function handleOrderWebhook(pool, topic, order) {
  const msg = messageFor(topic, order);
  if (!msg) return { ok: true, skipped: 'topic' };

  const numericId = order?.customer?.id;
  const email = order?.customer?.email || order?.email || null;
  if (!numericId && !email) return { ok: true, skipped: 'no_customer' };

  // Busca el dispositivo del cliente por dos vías:
  //   - customer_id: gid://shopify/Customer/<id> coincidente con el id
  //     numérico del webhook (cliente que ha hecho login en la app).
  //   - email: dispositivos cuyo cliente logado tenga el mismo email que
  //     el del pedido (cubre el caso de pedidos hechos desde la web con
  //     una cuenta de Shopify distinta a la del login en la app, mismo
  //     correo). Si la app no resolvió el email (versiones antiguas o
  //     sesión caducada), simplemente no aporta nada y se queda en el
  //     match por customer_id.
  const { rows } = await pool.query(
    `SELECT DISTINCT token FROM app_push_tokens
       WHERE COALESCE((prefs ->> 'orders')::boolean, true) = true
         AND (
              ($1::text IS NOT NULL AND customer_id LIKE $1)
           OR ($2::text IS NOT NULL AND lower(email) = lower($2))
         )`,
    [numericId ? `%/${numericId}` : null, email],
  );
  const tokens = rows.map((r) => r.token);

  const data = { category: 'orders', path: '/pedidos' };
  const id = await recordNotification(pool, {
    title: msg.title,
    body: msg.body,
    category: 'orders',
    data,
    audience: 'customer',
    customerId: `gid://shopify/Customer/${numericId}`,
    recipients: tokens.length,
  });

  if (tokens.length) {
    await sendPushToTokens(tokens, {
      title: msg.title,
      body: msg.body,
      data: id != null ? { ...data, notifId: id } : data,
    });
  }
  return { ok: true, recipients: tokens.length };
}
