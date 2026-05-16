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
