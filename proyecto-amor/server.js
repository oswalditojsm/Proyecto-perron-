// server.js
// Este archivo levanta un servidor web y expone una "API" para
// que la página pida y modifique mensajes/fotos/citas guardados en una base de datos.
//
// NOVEDAD: la base de datos ahora vive en Turso (SQLite en la nube) y las fotos
// subidas desde tu compu se guardan en Cloudinary — así nada se pierde cuando
// Render reinicia o duerme el servidor.

const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@libsql/client");
const cloudinary = require("cloudinary").v2;
const http = require("http");
const { WebSocketServer } = require("ws");

// ---- Carga simple de variables desde .env (si existe) ----
const rutaEnv = path.join(__dirname, ".env");
if (fs.existsSync(rutaEnv)) {
    fs.readFileSync(rutaEnv, "utf8").split("\n").forEach((linea) => {
        const limpia = linea.trim();
        if (!limpia || limpia.startsWith("#")) return;
        const i = limpia.indexOf("=");
        if (i === -1) return;
        const clave = limpia.slice(0, i).trim();
        const valor = limpia.slice(i + 1).trim();
        if (!(clave in process.env)) process.env[clave] = valor;
    });
}

const app = express();
app.set("trust proxy", 1);
const PUERTO = process.env.PORT || 3000;

// ---- Conexión a la base de datos ----
// Si defines TURSO_DATABASE_URL (en Render, producción) se conecta a Turso.
// Si NO lo defines (en tu compu, mientras pruebas) usa un archivo local, sin
// necesidad de tener cuenta de Turso para desarrollar.
const db = createClient(
    process.env.TURSO_DATABASE_URL
        ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
        : { url: "file:mensajes.db" }
);

// ---- Cloudinary (almacenamiento de fotos subidas desde la compu) ----
const CLOUDINARY_CONFIGURADO = Boolean(
    process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);
if (CLOUDINARY_CONFIGURADO) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}

function subirACloudinary(buffer) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: "proyecto-amor" },
            (error, resultado) => (error ? reject(error) : resolve(resultado))
        );
        stream.end(buffer);
    });
}

// ---- Funciones de ajustes (clave/valor: contraseña, fecha de inicio, fondo) ----
async function obtenerAjuste(clave, porDefecto = null) {
    const r = await db.execute({ sql: "SELECT valor FROM ajustes WHERE clave = ?", args: [clave] });
    return r.rows.length ? r.rows[0].valor : porDefecto;
}

async function guardarAjuste(clave, valor) {
    await db.execute({
        sql: `INSERT INTO ajustes (clave, valor) VALUES (?, ?)
              ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`,
        args: [clave, valor]
    });
}

// ---- Contraseña del panel: se guarda como hash, nunca en texto plano ----
const SAL = "sal-proyecto-amor-v1";
function hashClave(clave) {
    return crypto.createHash("sha256").update(clave + SAL).digest("hex");
}

// ---- Secreto de sesión ----
// Si defines SESSION_SECRET en Render, la sesión sobrevive a los reinicios.
// Si no, se genera uno y se guarda en un archivo local (se pierde en cada
// redeploy en Render, así que tendrías que volver a iniciar sesión — no es
// grave, no se pierde ningún dato, solo tendrías que loguearte de nuevo).
const RUTA_SECRETO = path.join(__dirname, ".session-secret");
let SECRETO_SESION = process.env.SESSION_SECRET;
if (!SECRETO_SESION) {
    if (fs.existsSync(RUTA_SECRETO)) {
        SECRETO_SESION = fs.readFileSync(RUTA_SECRETO, "utf8").trim();
    } else {
        SECRETO_SESION = crypto.randomBytes(32).toString("hex");
        fs.writeFileSync(RUTA_SECRETO, SECRETO_SESION);
    }
}

async function tokenValido() {
    const hashActual = await obtenerAjuste("password_hash");
    return crypto.createHmac("sha256", SECRETO_SESION).update(hashActual).digest("hex");
}

function parsearCookies(encabezado) {
    const cookies = {};
    if (!encabezado) return cookies;
    encabezado.split(";").forEach((parte) => {
        const i = parte.indexOf("=");
        if (i > -1) {
            const clave = parte.slice(0, i).trim();
            const valor = decodeURIComponent(parte.slice(i + 1).trim());
            cookies[clave] = valor;
        }
    });
    return cookies;
}

async function estaAutenticado(req) {
    const cookies = parsearCookies(req.headers.cookie);
    if (!cookies.admin_token) return false;
    return cookies.admin_token === (await tokenValido());
}

async function requiereAdmin(req, res, next) {
    if (await estaAutenticado(req)) return next();
    if (req.path.startsWith("/api/")) {
        return res.status(401).json({ error: "No autorizado, inicia sesión" });
    }
    res.redirect("/login.html");
}

// ---- Token de sesión para usuarios normales (ella, y quien apruebes) ----
// La cookie guarda "id.firma". La firma depende del id + el hash de SU
// contraseña, así que si cambia su contraseña, sus sesiones viejas dejan de
// servir automáticamente (igual que con el admin).
function firmarUsuario(id, passwordHash) {
    return crypto.createHmac("sha256", SECRETO_SESION).update(`${id}:${passwordHash}`).digest("hex");
}

async function usuarioDeCookie(req) {
    const cookies = parsearCookies(req.headers.cookie);
    if (!cookies.site_token) return null;
    const [id, firma] = cookies.site_token.split(".");
    if (!id || !firma) return null;

    const r = await db.execute({ sql: "SELECT * FROM usuarios WHERE id = ?", args: [id] });
    const usuario = r.rows[0];
    if (!usuario) return null;
    if (firma !== firmarUsuario(usuario.id, usuario.password_hash)) return null;
    if (usuario.estado !== "aprobado") return null;
    return usuario;
}

// Protege TODO el sitio: deja pasar si ya eres admin, o si eres un usuario
// aprobado. Si no, redirige a la pantalla de acceso (o responde 401 en la API).
async function requiereAcceso(req, res, next) {
    if (await estaAutenticado(req)) return next(); // el admin siempre puede ver el sitio
    if (await usuarioDeCookie(req)) return next();

    if (req.path.startsWith("/api/")) {
        return res.status(401).json({ error: "Necesitas iniciar sesión" });
    }
    res.redirect("/acceso.html");
}

// ---- Subida de fotos: se reciben en memoria y se mandan a Cloudinary ----
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB por foto
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/")) return cb(null, true);
        cb(new Error("Solo se permiten archivos de imagen"));
    }
});

// ---- Límites de peticiones (rate limiting) ----
// Limitador general: evita que alguien bombardee tu servidor con miles de
// peticiones. 200 peticiones cada 15 minutos por IP es generoso para uso
// normal, pero corta en seco un abuso automatizado.
const limitadorGeneral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Demasiadas peticiones desde tu conexión, espera unos minutos." }
});

// Limitador de login: mucho más estricto, específico para las rutas donde
// alguien podría intentar adivinar una contraseña a la fuerza (fuerza bruta).
// 5 intentos cada 15 minutos por IP.
const limitadorLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Demasiados intentos. Espera unos minutos antes de volver a intentar." }
});

// ---- Middlewares generales ----
app.use(express.json());
app.use("/api/", limitadorGeneral);
app.use(express.static(path.join(__dirname, "public")));

// ---- WebSockets: avisan a las páginas abiertas cuando algo cambió ----
// Usamos un servidor HTTP "manual" (en vez de app.listen directo) porque el
// WebSocketServer necesita engancharse al mismo servidor para compartir el
// puerto 3000 sin abrir uno nuevo.
const servidorHttp = http.createServer(app);
const wss = new WebSocketServer({ server: servidorHttp });

// Antes de aceptar la conexión, revisamos la misma cookie que ya usamos para
// proteger el sitio (admin o usuario aprobado). Así alguien sin sesión no
// puede conectarse a escuchar los avisos.
wss.on("connection", async (socket, req) => {
    const autorizado = (await estaAutenticado(req)) || Boolean(await usuarioDeCookie(req));
    if (!autorizado) {
        socket.close();
        return;
    }
});

// Avisa a todas las pestañas conectadas que algo de cierto "tipo" cambió
// (ej. "fotos", "mensajes", "citas", "usuarios", "ajustes"). No manda el
// contenido en sí, solo el aviso — cada página vuelve a pedir sus propios
// datos con fetch, respetando los mismos permisos de siempre.
function avisarCambio(tipo, extra = {}) {
    const paquete = JSON.stringify({ tipo, ...extra });
    wss.clients.forEach((cliente) => {
        if (cliente.readyState === cliente.OPEN) cliente.send(paquete);
    });
}

// ---- Páginas del sitio (protegidas: requieren cuenta aprobada, o ser admin) ----
app.get("/", requiereAcceso, (req, res) => {
    res.sendFile(path.join(__dirname, "protegido", "index.html"));
});
app.get("/fotos.html", requiereAcceso, (req, res) => {
    res.sendFile(path.join(__dirname, "protegido", "fotos.html"));
});
app.get("/cita.html", requiereAcceso, (req, res) => {
    res.sendFile(path.join(__dirname, "protegido", "cita.html"));
});
app.get("/chat.html", requiereAcceso, (req, res) => {
    res.sendFile(path.join(__dirname, "protegido", "chat.html"));
});

// Averigua quién manda un mensaje: el admin (tú) o la cuenta aprobada (ella).
// Se usa tanto para guardar el autor en la base de datos como para que el
// propio chat sepa mostrar tus mensajes de un lado y los de ella del otro.
async function obtenerAutor(req) {
    if (await estaAutenticado(req)) {
        return { tipo: "admin", nombre: await obtenerAjuste("admin_nombre", "Yo 💌") };
    }
    const usuario = await usuarioDeCookie(req);
    if (usuario) return { tipo: "usuario", nombre: usuario.usuario };
    return null;
}

// ---- Página de administración (protegida) ----
app.get("/admin", requiereAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, "private", "admin.html"));
});

// ---- Rutas de REGISTRO Y ACCESO (usuarios normales del sitio) ----
app.post("/api/registro", limitadorLogin, async (req, res) => {
    const usuario = (req.body?.usuario || "").trim();
    const password = req.body?.password || "";

    if (usuario.length < 3 || password.length < 4) {
        return res.status(400).json({ error: "El usuario debe tener al menos 3 letras y la contraseña al menos 4" });
    }

    const existe = await db.execute({ sql: "SELECT id FROM usuarios WHERE usuario = ?", args: [usuario] });
    if (existe.rows.length > 0) {
        return res.status(409).json({ error: "Ese nombre de usuario ya está registrado" });
    }

    await db.execute({
        sql: "INSERT INTO usuarios (usuario, password_hash, estado) VALUES (?, ?, 'pendiente')",
        args: [usuario, hashClave(password)]
    });
    res.status(201).json({ ok: true });
});

app.post("/api/login-usuario", limitadorLogin, async (req, res) => {
    const usuario = (req.body?.usuario || "").trim();
    const password = req.body?.password || "";

    const r = await db.execute({ sql: "SELECT * FROM usuarios WHERE usuario = ?", args: [usuario] });
    const cuenta = r.rows[0];

    if (!cuenta || hashClave(password) !== cuenta.password_hash) {
        return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }
    if (cuenta.estado === "pendiente") {
        return res.status(403).json({ error: "Tu cuenta todavía no ha sido aprobada" });
    }

    res.cookie("site_token", `${cuenta.id}.${firmarUsuario(cuenta.id, cuenta.password_hash)}`, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 90 * 24 * 60 * 60 * 1000
    });
    res.json({ ok: true });
});

app.post("/api/logout-usuario", (req, res) => {
    res.clearCookie("site_token");
    res.json({ ok: true });
});

// ---- Rutas de USUARIOS (solo admin: aprobar/rechazar registros) ----
app.get("/api/usuarios", requiereAdmin, async (req, res) => {
    const r = await db.execute("SELECT id, usuario, estado, creado_en FROM usuarios ORDER BY id DESC");
    res.json(r.rows);
});

app.post("/api/usuarios/:id/aprobar", requiereAdmin, async (req, res) => {
    await db.execute({ sql: "UPDATE usuarios SET estado = 'aprobado' WHERE id = ?", args: [req.params.id] });
    avisarCambio("usuarios");
    res.json({ ok: true });
});

app.delete("/api/usuarios/:id", requiereAdmin, async (req, res) => {
    // Sirve tanto para rechazar un registro pendiente como para quitarle el
    // acceso a alguien que ya estaba aprobado.
    await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [req.params.id] });
    avisarCambio("usuarios");
    res.status(204).send();
});
app.post("/api/login", limitadorLogin, async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: "Falta la contraseña" });

    const hashGuardado = await obtenerAjuste("password_hash");
    if (hashClave(password) === hashGuardado) {
        res.cookie("admin_token", await tokenValido(), {
            httpOnly: true,
            sameSite: "lax",
            maxAge: 30 * 24 * 60 * 60 * 1000
        });
        return res.json({ ok: true });
    }
    res.status(401).json({ error: "Contraseña incorrecta" });
});

app.post("/api/logout", (req, res) => {
    res.clearCookie("admin_token");
    res.json({ ok: true });
});

app.post("/api/cambiar-clave", requiereAdmin, async (req, res) => {
    const { actual, nueva } = req.body || {};
    if (!actual || !nueva || nueva.trim().length < 4) {
        return res.status(400).json({ error: "Revisa los campos (la nueva clave debe tener al menos 4 caracteres)" });
    }
    if (hashClave(actual) !== (await obtenerAjuste("password_hash"))) {
        return res.status(401).json({ error: "La contraseña actual no es correcta" });
    }
    await guardarAjuste("password_hash", hashClave(nueva.trim()));
    res.cookie("admin_token", await tokenValido(), {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000
    });
    res.json({ ok: true });
});

// ---- Rutas de MENSAJES ----
app.get("/api/mensajes/aleatorio", requiereAcceso, async (req, res) => {
    const r = await db.execute("SELECT * FROM mensajes");
    if (r.rows.length === 0) return res.json({ texto: "Todavía no hay mensajes 💌" });
    const elegido = r.rows[Math.floor(Math.random() * r.rows.length)];
    res.json(elegido);
});

app.get("/api/mensajes", requiereAdmin, async (req, res) => {
    const r = await db.execute("SELECT * FROM mensajes ORDER BY id DESC");
    res.json(r.rows);
});

app.post("/api/mensajes", requiereAdmin, async (req, res) => {
    const { texto } = req.body;
    if (!texto || texto.trim() === "") return res.status(400).json({ error: "El mensaje no puede estar vacío" });
    const r = await db.execute({ sql: "INSERT INTO mensajes (texto) VALUES (?)", args: [texto.trim()] });
    avisarCambio("mensajes");
    res.status(201).json({ id: Number(r.lastInsertRowid), texto: texto.trim() });
});

app.put("/api/mensajes/:id", requiereAdmin, async (req, res) => {
    const { id } = req.params;
    const { texto } = req.body;
    if (!texto || texto.trim() === "") return res.status(400).json({ error: "El mensaje no puede estar vacío" });
    await db.execute({ sql: "UPDATE mensajes SET texto = ? WHERE id = ?", args: [texto.trim(), id] });
    avisarCambio("mensajes");
    res.json({ id: Number(id), texto: texto.trim() });
});

app.delete("/api/mensajes/:id", requiereAdmin, async (req, res) => {
    await db.execute({ sql: "DELETE FROM mensajes WHERE id = ?", args: [req.params.id] });
    avisarCambio("mensajes");
    res.status(204).send();
});

// ---- Rutas de FOTOS ----
app.get("/api/fotos", requiereAcceso, async (req, res) => {
    const r = await db.execute("SELECT * FROM fotos ORDER BY id DESC");
    res.json(r.rows);
});

app.post("/api/fotos", requiereAdmin, async (req, res) => {
    const { url, mensaje } = req.body;
    if (!url || url.trim() === "") return res.status(400).json({ error: "La URL de la imagen es obligatoria" });
    const r = await db.execute({
        sql: "INSERT INTO fotos (url, mensaje) VALUES (?, ?)",
        args: [url.trim(), (mensaje || "").trim()]
    });
    avisarCambio("fotos");
    res.status(201).json({ id: Number(r.lastInsertRowid), url: url.trim(), mensaje: (mensaje || "").trim() });
});

app.post("/api/fotos/subir", requiereAdmin, (req, res) => {
    if (!CLOUDINARY_CONFIGURADO) {
        return res.status(400).json({
            error: "Cloudinary no está configurado en el servidor. Usa la opción de pegar un link mientras tanto."
        });
    }
    upload.single("foto")(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: "No llegó ninguna imagen" });

        try {
            const resultado = await subirACloudinary(req.file.buffer);
            const mensaje = (req.body.mensaje || "").trim();
            const r = await db.execute({
                sql: "INSERT INTO fotos (url, mensaje) VALUES (?, ?)",
                args: [resultado.secure_url, mensaje]
            });
            avisarCambio("fotos");
            res.status(201).json({ id: Number(r.lastInsertRowid), url: resultado.secure_url, mensaje });
        } catch (error) {
            res.status(500).json({ error: "No se pudo subir la imagen a Cloudinary" });
        }
    });
});

app.put("/api/fotos/:id", requiereAdmin, async (req, res) => {
    const { mensaje } = req.body;
    await db.execute({ sql: "UPDATE fotos SET mensaje = ? WHERE id = ?", args: [(mensaje || "").trim(), req.params.id] });
    avisarCambio("fotos");
    res.json({ id: Number(req.params.id), mensaje: (mensaje || "").trim() });
});

app.delete("/api/fotos/:id", requiereAdmin, async (req, res) => {
    // Nota: esto borra el registro de la base de datos. Si la imagen estaba en
    // Cloudinary, se queda ahí (no afecta tus 25 créditos gratis de forma
    // relevante para un proyecto personal chiquito como este).
    await db.execute({ sql: "DELETE FROM fotos WHERE id = ?", args: [req.params.id] });
    avisarCambio("fotos");
    res.status(204).send();
});

// ---- Rutas de CITAS ----
app.get("/api/citas", requiereAdmin, async (req, res) => {
    const r = await db.execute("SELECT * FROM citas ORDER BY id DESC");
    res.json(r.rows);
});

app.get("/api/citas/proxima", requiereAcceso, async (req, res) => {
    const r = await db.execute("SELECT * FROM citas");
    const ahora = new Date();
    const futuras = r.rows
        .map((c) => ({ ...c, cuando: new Date(`${c.fecha}T${c.hora}`) }))
        .filter((c) => !Number.isNaN(c.cuando.getTime()) && c.cuando >= ahora)
        .sort((a, b) => a.cuando - b.cuando);

    if (futuras.length === 0) return res.json(null);
    const { cuando, ...proxima } = futuras[0];
    res.json(proxima);
});

app.post("/api/citas", requiereAcceso, async (req, res) => {
    const { fecha, hora, mensaje } = req.body;
    if (!fecha || !hora) return res.status(400).json({ error: "Fecha y hora son obligatorias" });
    const r = await db.execute({
        sql: "INSERT INTO citas (fecha, hora, mensaje) VALUES (?, ?, ?)",
        args: [fecha, hora, (mensaje || "").trim()]
    });
    avisarCambio("citas");
    res.status(201).json({ id: Number(r.lastInsertRowid), fecha, hora, mensaje: (mensaje || "").trim() });
});

app.delete("/api/citas/:id", requiereAdmin, async (req, res) => {
    await db.execute({ sql: "DELETE FROM citas WHERE id = ?", args: [req.params.id] });
    avisarCambio("citas");
    res.status(204).send();
});

// ---- Rutas de AJUSTES ----
app.get("/api/config", requiereAcceso, async (req, res) => {
    res.json({
        fecha_inicio: await obtenerAjuste("fecha_inicio", null),
        fondo_url: await obtenerAjuste("fondo_url", null)
    });
});

app.post("/api/ajustes", requiereAdmin, async (req, res) => {
    const { fecha_inicio, fondo_url } = req.body || {};
    if (fecha_inicio !== undefined) await guardarAjuste("fecha_inicio", fecha_inicio);
    if (fondo_url !== undefined) await guardarAjuste("fondo_url", fondo_url);
    avisarCambio("ajustes");
    res.json({ ok: true });
});

// ---- Rutas de CHAT ----
app.get("/api/quien-soy", requiereAcceso, async (req, res) => {
    const autor = await obtenerAutor(req);
    res.json(autor);
});

app.get("/api/chat", requiereAcceso, async (req, res) => {
    // Los últimos 300 mensajes, del más viejo al más nuevo (así se leen de
    // arriba hacia abajo, como en cualquier chat).
    const r = await db.execute(`
        SELECT * FROM (
            SELECT * FROM chat_mensajes ORDER BY id DESC LIMIT 300
        ) recientes ORDER BY id ASC
    `);
    res.json(r.rows);
});

app.post("/api/chat", requiereAcceso, async (req, res) => {
    const texto = (req.body?.texto || "").trim();
    if (!texto) return res.status(400).json({ error: "El mensaje no puede estar vacío" });
    if (texto.length > 2000) return res.status(400).json({ error: "Mensaje demasiado largo" });

    const autor = await obtenerAutor(req);
    const r = await db.execute({
        sql: "INSERT INTO chat_mensajes (autor_tipo, autor_nombre, texto) VALUES (?, ?, ?)",
        args: [autor.tipo, autor.nombre, texto]
    });
    const mensaje = {
        id: Number(r.lastInsertRowid),
        autor_tipo: autor.tipo,
        autor_nombre: autor.nombre,
        texto,
        imagen_url: null,
        creado_en: new Date().toISOString()
    };
    avisarCambio("chat", { mensaje });
    res.status(201).json(mensaje);
});

app.post("/api/chat/imagen", requiereAcceso, (req, res) => {
    if (!CLOUDINARY_CONFIGURADO) {
        return res.status(400).json({ error: "Cloudinary no está configurado en el servidor." });
    }
    upload.single("imagen")(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: "No llegó ninguna imagen" });

        try {
            const autor = await obtenerAutor(req);
            const texto = (req.body.texto || "").trim();
            const resultado = await subirACloudinary(req.file.buffer);
            const r = await db.execute({
                sql: "INSERT INTO chat_mensajes (autor_tipo, autor_nombre, texto, imagen_url) VALUES (?, ?, ?, ?)",
                args: [autor.tipo, autor.nombre, texto || null, resultado.secure_url]
            });
            const mensaje = {
                id: Number(r.lastInsertRowid),
                autor_tipo: autor.tipo,
                autor_nombre: autor.nombre,
                texto: texto || null,
                imagen_url: resultado.secure_url,
                creado_en: new Date().toISOString()
            };
            avisarCambio("chat", { mensaje });
            res.status(201).json(mensaje);
        } catch (error) {
            res.status(500).json({ error: "No se pudo subir la imagen a Cloudinary" });
        }
    });
});

// ---- Inicialización de la base de datos y arranque del servidor ----
async function iniciar() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS mensajes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            texto TEXT NOT NULL
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS fotos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL,
            mensaje TEXT
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS citas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha TEXT NOT NULL,
            hora TEXT NOT NULL,
            mensaje TEXT,
            creado_en TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS ajustes (
            clave TEXT PRIMARY KEY,
            valor TEXT
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            estado TEXT NOT NULL DEFAULT 'pendiente',
            creado_en TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS chat_mensajes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            autor_tipo TEXT NOT NULL,
            autor_nombre TEXT NOT NULL,
            texto TEXT,
            imagen_url TEXT,
            creado_en TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const cantidad = await db.execute("SELECT COUNT(*) AS total FROM mensajes");
    if (Number(cantidad.rows[0].total) === 0) {
        const mensajesIniciales = [
            "Espero que hoy tengas un día hermoso, igual que tú 😍",
            "Eres lo mejor que me ha pasado 💖",
            "Hoy quiero recordarte cuánto te amo ❤️",
            "Eres mi persona favorita 🌎💕",
            "Tu sonrisa ilumina mi vida ✨",
            "Ojalá pudiera abrazarte ahora 🤗",
            "Eres mi todo 💕"
        ];
        for (const texto of mensajesIniciales) {
            await db.execute({ sql: "INSERT INTO mensajes (texto) VALUES (?)", args: [texto] });
        }
        console.log("Base de datos creada con mensajes iniciales.");
    }

    if (!(await obtenerAjuste("password_hash"))) {
        const claveInicial = process.env.ADMIN_PASSWORD || "cambiame123";
        await guardarAjuste("password_hash", hashClave(claveInicial));
        console.log("──────────────────────────────────────────────");
        console.log(`Contraseña inicial del panel de admin: "${claveInicial}"`);
        console.log("Puedes cambiarla luego desde /admin → pestaña Ajustes.");
        console.log("──────────────────────────────────────────────");
    }

    servidorHttp.listen(PUERTO, () => {
        console.log(`Servidor corriendo en http://localhost:${PUERTO}`);
        console.log(`Panel de administración en http://localhost:${PUERTO}/admin`);
        console.log(`Base de datos: ${process.env.TURSO_DATABASE_URL ? "Turso (nube)" : "archivo local (mensajes.db)"}`);
        console.log(`Fotos subidas: ${CLOUDINARY_CONFIGURADO ? "Cloudinary (nube)" : "no configurado — usa la opción de URL"}`);
    });
}

iniciar();
