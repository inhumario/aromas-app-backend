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
| DELETE | `/me/account` | Borrar la cuenta del cliente (deseos, notas, desvincular dispositivos). Registra la solicitud en `app_account_deletions` para que el cliente de Shopify se elimine después a mano. Requisito App Store 5.1.1(v). |

### Contenido editable del inicio

La pantalla de inicio de la app tiene una **pastilla de ofertas** y un **mini
popup de bienvenida** cuyo texto y destino edita Mario desde el panel `/admin`
(usuario/contraseña), sin publicar una versión nueva de la app.

| Método | Ruta | Acceso | Para qué |
|---|---|---|---|
| GET | `/home/promo` | público | La app lee la pastilla y el popup al arrancar |
| GET | `/home/promo/image` | público | Imagen del popup subida desde el panel |
| GET | `/admin/promo` | `Basic` admin | El panel carga el contenido actual |
| POST | `/admin/promo` | `Basic` admin | Guardar contenido (sube `revision`: el popup reaparece una vez) |
| POST | `/admin/promo/image` | `Basic` admin | Subir la imagen del popup (cuerpo = fichero en crudo) |
| DELETE | `/admin/promo/image` | `Basic` admin | Quitar la imagen del popup |

Se guarda en la tabla `app_home_promo` (una sola fila). El popup se muestra
**una vez por promoción**: la app recuerda la `revision` vista y solo lo enseña
de nuevo cuando cambia. La imagen del popup se guarda como `bytea` en esa misma
tabla y se sirve en `/home/promo/image`.

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
