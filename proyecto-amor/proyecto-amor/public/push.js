// push.js
// Muestra un pequeño aviso para activar notificaciones (mensajes nuevos y
// citas nuevas), y si la persona acepta, la suscribe. Si algo no es
// compatible (navegador viejo, no es HTTPS, etc.) simplemente no hace nada:
// el resto del sitio sigue funcionando normal.

(function () {
    const SOPORTADO = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (!SOPORTADO) return;

    // Ya se activaron antes en este navegador: no molestamos de nuevo.
    if (localStorage.getItem("notif_activadas") === "1") {
        // Igual nos aseguramos de que la suscripción siga viva (por si el
        // navegador la invalidó sola, ej. tras mucho tiempo sin usarse, o si
        // en su momento falló en silencio). Si vuelve a fallar, quitamos la
        // marca para que el banner aparezca de nuevo la próxima vez.
        asegurarSuscripcion().catch(() => localStorage.removeItem("notif_activadas"));
        return;
    }

    // Ya dijo que no antes: respetamos su decisión y no insistimos.
    if (localStorage.getItem("notif_rechazadas") === "1") return;

    // El navegador ya tiene el permiso bloqueado a nivel sistema: no hay
    // banner que valga, tendría que activarlo desde los ajustes del navegador.
    if (Notification.permission === "denied") return;

    mostrarBanner();

    function mostrarBanner() {
        const banner = document.createElement("div");
        banner.className = "banner-notificaciones";
        banner.innerHTML = `
            <span>🔔 ¿Te aviso cuando te escriban o agenden una cita?</span>
            <div class="banner-notificaciones-botones">
                <button type="button" class="activar">Activar</button>
                <button type="button" class="ahora-no">Ahora no</button>
            </div>
        `;
        document.body.appendChild(banner);

        banner.querySelector(".ahora-no").addEventListener("click", () => {
            localStorage.setItem("notif_rechazadas", "1");
            banner.remove();
        });

        banner.querySelector(".activar").addEventListener("click", async () => {
            banner.querySelector(".activar").textContent = "Activando...";
            try {
                await activarNotificaciones();
                localStorage.setItem("notif_activadas", "1");
                banner.remove();
            } catch (error) {
                banner.remove();
                if (error.message === "push-no-configurado-en-servidor") {
                    alert("El servidor todavía no tiene las notificaciones configuradas (faltan las llaves VAPID en el .env). Avísale a quien administra el sitio.");
                    // No marcamos nada en localStorage: así el banner vuelve
                    // a aparecer la próxima vez, cuando ya esté configurado.
                } else if (error.message === "Permiso no concedido") {
                    // El usuario dijo "No permitir" en el diálogo del sistema; no insistimos.
                    localStorage.setItem("notif_rechazadas", "1");
                } else {
                    alert("No se pudo activar las notificaciones, intenta de nuevo más tarde.");
                }
            }
        });
    }

    async function activarNotificaciones() {
        const permiso = await Notification.requestPermission();
        if (permiso !== "granted") throw new Error("Permiso no concedido");
        await asegurarSuscripcion();
    }

    async function asegurarSuscripcion() {
        const registro = await navigator.serviceWorker.ready;
        let suscripcion = await registro.pushManager.getSubscription();

        if (!suscripcion) {
            const respuestaLlave = await fetch("/api/push/vapid-public-key");
            if (!respuestaLlave.ok) {
                // El servidor no tiene VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
                // configuradas (falta el .env, o no se redesplegó con ellas).
                throw new Error("push-no-configurado-en-servidor");
            }
            const { publicKey } = await respuestaLlave.json();

            suscripcion = await registro.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: convertirLlave(publicKey)
            });
        }

        const respuestaGuardar = await fetch("/api/push/suscribir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ suscripcion })
        });
        if (!respuestaGuardar.ok) throw new Error("no-se-pudo-guardar-suscripcion");
    }

    // Web Push necesita la llave pública como bytes, no como texto.
    function convertirLlave(base64url) {
        const relleno = "=".repeat((4 - (base64url.length % 4)) % 4);
        const base64 = (base64url + relleno).replace(/-/g, "+").replace(/_/g, "/");
        const bruto = atob(base64);
        return Uint8Array.from([...bruto].map((c) => c.charCodeAt(0)));
    }
})();
