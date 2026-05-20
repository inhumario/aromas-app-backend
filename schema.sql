-- Esquema del backend de la app Aromas de Té.
-- Tablas con prefijo `app_` para no chocar con el resto de la base de datos.

CREATE TABLE IF NOT EXISTS app_wishlist (
  customer_id  text        NOT NULL,
  product_id   text        NOT NULL,
  handle       text,
  title        text,
  image_url    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);

CREATE TABLE IF NOT EXISTS app_tasting_notes (
  customer_id  text        NOT NULL,
  product_id   text        NOT NULL,
  handle       text,
  title        text,
  image_url    text,
  rating       text        NOT NULL,          -- 'like' | 'dislike'
  note         text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);

-- Tokens de notificación push de cada dispositivo con la app instalada.
CREATE TABLE IF NOT EXISTS app_push_tokens (
  token        text        PRIMARY KEY,
  customer_id  text,
  platform     text,
  prefs        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Historial de notificaciones enviadas. Alimenta el buzón de la app y las
-- estadísticas de apertura del panel.
CREATE TABLE IF NOT EXISTS app_notifications (
  id           bigserial   PRIMARY KEY,
  title        text        NOT NULL,
  body         text        NOT NULL,
  category     text,
  data         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  audience     text        NOT NULL DEFAULT 'all',   -- 'all' | 'customer'
  customer_id  text,                                  -- definido si audience = 'customer'
  recipients   integer     NOT NULL DEFAULT 0,        -- dispositivos a los que se envió
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_notifications_created_idx
  ON app_notifications (created_at DESC);

-- Aperturas de cada notificación: marca las leídas y mide cuánta gente la abre.
-- `reader` es el token push del dispositivo que la abrió.
CREATE TABLE IF NOT EXISTS app_notification_reads (
  notification_id bigint      NOT NULL REFERENCES app_notifications(id) ON DELETE CASCADE,
  reader          text        NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, reader)
);

-- Notificaciones que cada dispositivo ha borrado de su buzón.
-- `reader` es el token push del dispositivo.
CREATE TABLE IF NOT EXISTS app_notification_dismissed (
  notification_id bigint      NOT NULL REFERENCES app_notifications(id) ON DELETE CASCADE,
  reader          text        NOT NULL,
  dismissed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, reader)
);

-- Contenido editable de la pantalla de inicio de la app: la pastilla de
-- "ofertas del mes" y el mini popup de bienvenida. Una sola fila (id = 1);
-- el panel de administración (/admin) la edita y la app la lee sin necesidad
-- de publicar una versión nueva.
CREATE TABLE IF NOT EXISTS app_home_promo (
  id             integer     PRIMARY KEY DEFAULT 1,
  -- Pastilla en la pantalla de inicio
  pill_enabled   boolean     NOT NULL DEFAULT false,
  pill_emoji     text,                              -- emoji opcional, ej. 🍵
  pill_label     text,                              -- antetítulo, ej. "Oferta del mes"
  pill_text      text,                              -- texto principal de la pastilla
  -- Mini popup al abrir la app
  popup_enabled  boolean     NOT NULL DEFAULT false,
  popup_title    text,
  popup_body     text,
  popup_image    text,                              -- URL de imagen opcional
  -- Común a pastilla y popup: destino al pulsar y texto del botón
  link           text,                              -- ruta de la app (/coleccion/...) o https://
  cta_label      text,                              -- texto del botón, ej. "Ver ofertas"
  -- Sube en cada guardado; la app lo usa para mostrar el popup una sola vez
  -- por promoción (cuando cambias el contenido, vuelve a aparecer una vez).
  revision       integer     NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_home_promo_singleton CHECK (id = 1)
);

-- La fila única siempre debe existir (deshabilitada por defecto).
INSERT INTO app_home_promo (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Imagen del popup subida desde el panel (se sirve en GET /home/promo/image).
-- Se añade con ALTER para tablas `app_home_promo` ya creadas en despliegues
-- anteriores; es idempotente.
ALTER TABLE app_home_promo ADD COLUMN IF NOT EXISTS popup_image_data bytea;
ALTER TABLE app_home_promo ADD COLUMN IF NOT EXISTS popup_image_mime text;

-- Solicitudes de borrado de cuenta iniciadas desde la app (App Store 5.1.1(v)).
-- Al pulsar "Eliminar mi cuenta" la app borra todos los datos del cliente en
-- este backend y deja una marca aquí. El cliente de Shopify lo limpia Mario
-- a mano cuando le viene bien.
CREATE TABLE IF NOT EXISTS app_account_deletions (
  customer_id  text        PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now()
);
