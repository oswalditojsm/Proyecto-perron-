// pwa.js
// Registra el service worker para que el sitio se pueda "instalar" como app
// en el celular (ícono en la pantalla de inicio, abre sin barra del
// navegador). No hace nada más — la lógica de qué se cachea vive en sw.js.
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {
            // Si falla (ej. navegador viejo), el sitio sigue funcionando
            // normal como página web, solo sin la parte de "instalar".
        });
    });
}
