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

### Panel de administración (`/admin`)

Multi-usuario con cookie de sesión firmada (HttpOnly, Secure, SameSite=Strict).
Rate-limit en login: 5 intentos fallidos por IP en 10 minutos.

- `ADMIN_USER` / `ADMIN_PASSWORD` solo se usan la **primera vez** que arranca,
  para crear automáticamente el usuario admin inicial. Después, se gestionan
  desde el propio panel.
- Roles:
  - `admin`: todo, incluida la pestaña **Usuarios** (alta, baja, edit, reset
    contraseña, bloqueo).
  - `editor`: edita contenido y envía notificaciones, pero NO ve la pestaña
    de usuarios.
- Cualquier usuario puede cambiar su propia contraseña desde la pestaña
  **Mi cuenta** (requiere la contraseña actual).
- Salvaguardas anti-lockout: no puedes borrarte / desactivarte / quitarte
  el rol admin a ti mismo. Tampoco se puede borrar al último admin activo.

#### Endpoints de sesión y usuarios

| Método | Ruta | Acceso | Para qué |
|---|---|---|---|
| POST | `/admin/login` | público | Login con `{username, password}`; emite cookie |
| POST | `/admin/logout` | público | Borra la cookie de sesión |
| GET | `/admin/me` | sesión | Datos del usuario logado |
| POST | `/admin/me/password` | sesión | Cambiar la propia contraseña (`{currentPassword, newPassword}`) |
| GET | `/admin/users` | admin | Listar usuarios |
| POST | `/admin/users` | admin | Crear (`{username, password, role}`) |
| PATCH | `/admin/users/:id` | admin | Editar `{role?, enabled?, newPassword?}` |
| DELETE | `/admin/users/:id` | admin | Eliminar |

### Contenido editable del inicio

La pantalla de inicio de la app tiene una **pastilla de ofertas** y un **mini
popup de bienvenida** cuyo texto y destino edita Mario desde el panel `/admin`,
sin publicar una versión nueva de la app.

| Método | Ruta | Acceso | Para qué |
|---|---|---|---|
| GET | `/home/promo` | público | La app lee la pastilla y el popup al arrancar |
| GET | `/home/promo/image` | público | Imagen del popup subida desde el panel |
| GET | `/admin/promo` | sesión | El panel carga el contenido actual |
| POST | `/admin/promo` | sesión | Guardar contenido (sube `revision`: el popup reaparece una vez) |
| POST | `/admin/promo/image` | sesión | Subir la imagen del popup (cuerpo = fichero en crudo) |
| DELETE | `/admin/promo/image` | sesión | Quitar la imagen del popup |

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
