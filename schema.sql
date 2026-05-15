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
