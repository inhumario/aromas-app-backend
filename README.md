# Backend de la app Aromas de Té

API mínima para las funciones que necesitan guardarse **en la nube**, ligadas a
la cuenta del cliente:

- **Lista de deseos** — tés que el cliente guarda para futuras compras.
- **Notas de cata** — valoración personal (👍/👎 + nota) de los tés que ha pedido.

Los datos se guardan en **Postgres** (el de Aromas). La identidad del cliente se
valida contra la **Customer Account API de Shopify**: la app envía su token de
cliente y este servicio lo verifica antes de leer/escribir.

## Endpoints

Todos (salvo `/health`) requieren cabecera `Authorization: <token de cliente Shopify>`.

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/health` | Estado del servicio |
| GET | `/me/wishlist` | Lista de deseos del cliente |
| POST | `/me/wishlist` | Añadir producto (`{productId, handle, title, imageUrl}`) |
| DELETE | `/me/wishlist/:productId` | Quitar producto |
| GET | `/me/tasting-notes` | Notas de cata del cliente |
| PUT | `/me/tasting-notes/:productId` | Guardar nota (`{rating:'like'\|'dislike', note, handle, title, imageUrl}`) |
| DELETE | `/me/tasting-notes/:productId` | Borrar nota |

## Despliegue

Pensado para correr en **easypanel** (el panel de Aromas) como servicio Docker:

1. Crear un servicio "App" en easypanel desde este repo / esta carpeta.
2. Variables de entorno: ver `.env.example` (usar la URL interna de Postgres).
3. easypanel construye el `Dockerfile` y expone el servicio con HTTPS.
4. La app móvil apunta a esa URL (`EXPO_PUBLIC_APP_API_URL`).

El esquema de base de datos (`schema.sql`) se crea solo al arrancar.

## Local

```bash
npm install
cp .env.example .env   # y rellenar
npm start
```
