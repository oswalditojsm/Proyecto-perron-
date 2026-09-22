# Para mi amor 💖

Sitio web con mensajitos de amor, galería de fotos y agenda de citas — con panel privado para administrarlo todo.

Los datos se guardan en **Turso** (base de datos en la nube) y las fotos subidas desde tu compu en **Cloudinary** — así nada se pierde cuando el hosting gratis reinicia o duerme el servidor.

## Cómo correrlo en tu computadora (para probar, sin necesidad de cuentas todavía)

1. Instala las dependencias:
   ```
   npm install
   ```
2. Copia `.env.example` a `.env`:
   ```
   cp .env.example .env
   ```
   Puedes dejar `TURSO_DATABASE_URL` y las variables de `CLOUDINARY_` vacías por ahora — el proyecto usa un archivo local (`mensajes.db`) automáticamente y la opción de "pegar un link" para fotos sigue funcionando sin Cloudinary.
3. Arranca el servidor:
   ```
   npm start
   ```
4. Abre en tu navegador:
   - `http://localhost:3000` → el sitio que ella va a ver
   - `http://localhost:3000/admin` → tu panel privado (pide contraseña; la inicial aparece en la consola si no la definiste en `.env`)

## Cómo activar la persistencia real (para cuando lo subas a Render)

### 1. Turso (mensajes, citas, contraseña, ajustes)
1. Crea cuenta gratis en [turso.tech](https://turso.tech)
2. Crea una base de datos nueva
3. Dentro de ella, click en "Connect" (o el comando `turso db show --url` si usas su CLI) y copia la URL
4. Genera un token de acceso (auth token) desde el mismo panel
5. Guarda ambos como `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`

### 2. Cloudinary (fotos subidas desde tu compu)
1. Crea cuenta gratis en [cloudinary.com](https://cloudinary.com)
2. En tu Dashboard vas a ver directamente: **Cloud name**, **API Key**, **API Secret**
3. Guárdalos como `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

### 3. En Render
Agrega estas mismas variables (las 5 de arriba, más `ADMIN_PASSWORD` y opcionalmente `SESSION_SECRET`) en tu servicio → pestaña **Environment**. Con `TURSO_DATABASE_URL` configurado, Render usará Turso automáticamente en vez del archivo local.

## Acceso al sitio (registro + aprobación)

Ahora todo el sitio (inicio, fotos, citas) está protegido — nadie lo ve sin haber iniciado sesión.

1. Cualquiera con el link puede entrar a `/registro.html` y crear una cuenta (usuario + contraseña). Queda como **pendiente**.
2. Tú, desde `/admin` → pestaña **Usuarios**, la apruebas (o la rechazas).
3. Una vez aprobada, esa persona puede iniciar sesión en `/acceso.html` y ya ve todo el sitio normalmente.
4. Como admin, tú **no** necesitas registrarte — tu login de `/admin` te deja ver el sitio completo también.

Puedes usar esto para crear la cuenta de tu novia: que se registre ella misma, o le compartes usuario/contraseña que definiste tú, y solo la apruebas desde el panel.

## Qué puedes hacer desde el panel de admin (`/admin`)

- **Mensajes**: agregar, editar o borrar los mensajitos que aparecen al azar en la página principal.
- **Fotos**: subir fotos directamente desde tu computadora (van a Cloudinary) o pegar un link, y editar/borrar.
- **Citas**: ver las citas que ella agende desde `/cita.html`.
- **Usuarios**: aprobar o rechazar cuentas nuevas, o quitarle el acceso a alguien.
- **Ajustes**:
  - Fecha de inicio → activa el contador de "llevamos X días juntos" en la página principal.
  - Imagen de fondo → pon una foto de ustedes dos como fondo de todo el sitio.
  - Cambiar contraseña del panel.

## Seguridad — qué tan protegido está esto

- La contraseña se guarda como hash (no en texto plano) y las rutas que modifican datos o muestran las citas están protegidas.
- Es un nivel de seguridad adecuado para un proyecto personal/romántico, **no** para datos sensibles de verdad. No reutilices una contraseña importante aquí.
- Nunca subas tu archivo `.env` a GitHub — el `.gitignore` ya lo excluye por ti.

## Cómo ponerlo en línea para que ella lo vea desde su celular

1. **Render** (render.com) — conecta tu repo de GitHub, elige "Web Service", build command `npm install`, start command `npm start`. Agrega las variables de entorno de la sección anterior.
2. **Railway** (railway.app) — alternativa muy similar, también con despliegue directo desde GitHub.

Con Turso y Cloudinary configurados, tus mensajes, fotos y citas sobreviven a cualquier reinicio o redeploy del hosting.

## Estructura del proyecto

```
proyecto-amor/
├── server.js              # Backend: rutas, autenticación, base de datos
├── package.json
├── .env.example            # Copia a .env para definir tus claves
├── private/
│   └── admin.html          # Panel de administración (protegido, solo admin)
├── protegido/
│   ├── index.html           # Página principal (protegida, requiere login)
│   ├── fotos.html           # Galería de fotos (protegida)
│   └── cita.html            # Formulario para agendar citas (protegido)
└── public/
    ├── login.html           # Login del panel de admin
    ├── acceso.html          # Login del sitio (usuarios normales)
    ├── registro.html        # Crear cuenta nueva (queda pendiente de aprobación)
    └── style.css            # Estilos compartidos por todo el sitio
```
