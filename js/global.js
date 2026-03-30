document.addEventListener('DOMContentLoaded', function() {
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
