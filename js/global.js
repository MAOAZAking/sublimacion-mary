document.addEventListener('DOMContentLoaded', function() {
    // Lógica del Logo de Fondo
        const bg = document.createElement('div');
        bg.id = 'background-logo';
        document.body.prepend(bg);

        function updateBg() {
            const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 2) || window.innerWidth < 768;
            if (isMobile) {
                if (window.innerHeight > window.innerWidth) {
                    bg.style.backgroundSize = "90vw auto"; // Vertical: 90% del ancho
                } else {
                    bg.style.backgroundSize = "auto 90vh"; // Horizontal: 90% del alto
                }
            } else {
                bg.style.backgroundSize = "auto 90vh"; // Escritorio: 90% del alto
            }
        }
        updateBg();

        if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 2) || window.innerWidth < 768) {
            setInterval(updateBg, 1000); // Móvil: Actualizar cada segundo
        } else {
            window.addEventListener('resize', updateBg); // Escritorio: Solo al redimensionar
        }

    // 1. Copyright Year Logic
    const copyrightSpan = document.getElementById('copyright-year');
    if (copyrightSpan) {
        copyrightSpan.textContent = new Date().getFullYear();
    }

    // --- Funciones de Redirección Globales ---
    // Esta función determina la base URL correcta para GitHub Pages o entornos normales.
    window.getBaseUrl = function() {
        const hostname = window.location.hostname;
        if (hostname.includes('github.io')) {
            // Para GitHub Pages, la base URL incluye el nombre del repositorio
            const pathParts = window.location.pathname.split('/');
            // Asumiendo que el nombre del repo es la segunda parte de la ruta (ej: /repo-name/)
            return '/' + pathParts[1] + '/';
        } else {
            // Para otros entornos (como Render o local), la base URL es solo la raíz
            return '/';
        }
    };

    // Funciones de redirección específicas
    window.redirectToHome = function() { window.location.href = window.getBaseUrl(); };
    window.redirectToAdminDashboard = function() { window.location.href = window.getBaseUrl() + 'admin_dashboard.html'; };
    window.redirectToIndex = function() { window.location.href = window.getBaseUrl() + 'index.html'; };
});
