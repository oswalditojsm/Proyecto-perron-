// sw.js — Service Worker
// Su único trabajo es hacer que la "app" (el ícono en el celular) abra rápido
// y no se vea rota si por un segundo no hay señal. Los datos reales
// (mensajes, fotos, citas, chat) NUNCA se cachean aquí — siempre se piden
// frescos al servidor, así nunca ves información vieja.

const CACHE = "proyecto-amor-v3";
const ARCHIVOS_BASE = [
    "/style.css",
    "/websocket.js",
    "/pwa.js",
    "/push.js",
    "/offline.html",
    "/iconos/usuario-192.png",
    "/iconos/usuario-512.png",
    "/iconos/admin-192.png",
    "/iconos/admin-512.png"
];

self.addEventListener("install", (evento) => {
    evento.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(ARCHIVOS_BASE))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (evento) => {
    evento.waitUntil(
        caches.keys().then((claves) =>
            Promise.all(claves.filter((c) => c !== CACHE).map((c) => caches.delete(c)))
        )
    );
    self.clients.claim();
});

// ---- Notificaciones push ----
// El servidor manda un JSON simple: { titulo, cuerpo, url }. Aquí solo lo
// mostramos; el propio sistema operativo se encarga de sonar/vibrar según
// la configuración del celular.
self.addEventListener("push", (evento) => {
    let datos = { titulo: "Para mi amor 💖", cuerpo: "Tienes algo nuevo", url: "/" };
    try {
        datos = { ...datos, ...evento.data.json() };
    } catch {
        // Si por algún motivo no llega como JSON, nos quedamos con lo genérico.
    }

    evento.waitUntil(
        self.registration.showNotification(datos.titulo, {
            body: datos.cuerpo,
            icon: "/iconos/usuario-192.png",
            badge: "/iconos/usuario-192.png",
            data: { url: datos.url || "/" },
            vibrate: [120, 60, 120]
        })
    );
});

// Al tocar la notificación: si ya hay una pestaña abierta del sitio, la
// enfoca y la manda a la página correspondiente; si no, abre una nueva.
self.addEventListener("notificationclick", (evento) => {
    evento.notification.close();
    const url = evento.notification.data?.url || "/";

    evento.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((listaClientes) => {
            for (const cliente of listaClientes) {
                if ("focus" in cliente) {
                    cliente.navigate(url);
                    return cliente.focus();
                }
            }
            return self.clients.openWindow(url);
        })
    );
});

self.addEventListener("fetch", (evento) => {
    const { request } = evento;

    // La API y los WebSockets nunca pasan por el cache: siempre en vivo.
    if (request.url.includes("/api/") || request.headers.get("upgrade") === "websocket") {
        return;
    }

    // Navegación entre páginas: intenta la red primero (para tener siempre la
    // versión más nueva); si no hay conexión, muestra algo del cache o la
    // pantalla de "sin conexión" en vez de un error feo del navegador.
    if (request.mode === "navigate") {
        evento.respondWith(
            fetch(request).catch(
                () => caches.match(request).then((r) => r || caches.match("/offline.html"))
            )
        );
        return;
    }

    // Archivos estáticos (css, js, íconos): responde rápido desde el cache y
    // de paso actualiza el cache en segundo plano.
    evento.respondWith(
        caches.match(request).then((cacheada) => {
            const redFetch = fetch(request)
                .then((respuesta) => {
                    caches.open(CACHE).then((cache) => cache.put(request, respuesta.clone()));
                    return respuesta;
                })
                .catch(() => cacheada);
            return cacheada || redFetch;
        })
    );
});
