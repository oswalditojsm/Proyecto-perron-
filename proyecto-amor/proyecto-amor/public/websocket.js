// websocket.js
// Conecta con el servidor por WebSocket para enterarnos al instante cuando
// algo cambió (nueva foto, mensaje, cita, etc.) y así refrescar la página
// sola, sin que la persona tenga que recargarla a mano.
//
// Si la conexión se cae (el celular pierde señal, el hosting gratis
// duerme el servidor, etc.) se reintenta solo, con una espera que va
// creciendo (1s, 2s, 4s... hasta un máximo de 30s) para no saturar.

function conectarWebSocket(manejarMensaje) {
    const protocolo = location.protocol === "https:" ? "wss:" : "ws:";
    let intentos = 0;
    let socket = null;

    function conectar() {
        socket = new WebSocket(`${protocolo}//${location.host}`);

        socket.addEventListener("open", () => {
            intentos = 0;
        });

        socket.addEventListener("message", (evento) => {
            try {
                const datos = JSON.parse(evento.data);
                manejarMensaje(datos);
            } catch (error) {
                // Si llega algo que no es JSON válido, lo ignoramos.
            }
        });

        socket.addEventListener("close", () => {
            intentos++;
            const espera = Math.min(1000 * 2 ** intentos, 30000);
            setTimeout(conectar, espera);
        });

        socket.addEventListener("error", () => {
            socket.close();
        });
    }

    conectar();
}
