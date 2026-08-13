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
        // navegador la invalidó sola, ej. tras mucho tiempo sin usarse).
        asegurarSuscripcion().catch(() => {});
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
            } catch (error) {
                localStorage.setItem("notif_rechazadas", "1");
            } finally {
                banner.remove();
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
            if (!respuestaLlave.ok) return; // el servidor no tiene push configurado
            const { publicKey } = await respuestaLlave.json();

            suscripcion = await registro.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: convertirLlave(publicKey)
            });
        }

        await fetch("/api/push/suscribir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ suscripcion })
        });
    }

    // Web Push necesita la llave pública como bytes, no como texto.
    function convertirLlave(base64url) {
        const relleno = "=".repeat((4 - (base64url.length % 4)) % 4);
        const base64 = (base64url + relleno).replace(/-/g, "+").replace(/_/g, "/");
        const bruto = atob(base64);
        return Uint8Array.from([...bruto].map((c) => c.charCodeAt(0)));
    }
})();
