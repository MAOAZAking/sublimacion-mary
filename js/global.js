// --- Funciones de Redirección Globales ---
// Esta función determina la base URL correcta para GitHub Pages o entornos locales/Render.
window.getBaseUrl = function() {
    const hostname = window.location.hostname;
    if (hostname.includes('github.io')) {
        // Para GitHub Pages, la base URL incluye el nombre del repositorio
        const pathParts = window.location.pathname.split('/');
        // Asumiendo que el nombre del repo es la segunda parte de la ruta (ej: /repo-name/)
        return '/' + pathParts[1] + '/';
    } else {
        // Para otros entornos (como Render o localhost), la base URL es solo la raíz
        return '/';
    }
};

// Funciones de redirección comunes
window.redirectToIndex = function() { window.location.href = window.getBaseUrl(); };
window.redirectToAdminDashboard = function() { window.location.href = window.getBaseUrl() + 'admin_dashboard.html'; };

document.addEventListener('DOMContentLoaded', function() {
    // Asegurar que el contenedor del logo de fondo exista (si no está en el HTML)
    if (!document.getElementById('background-logo')) {
        const bg = document.createElement('div');
        bg.id = 'background-logo';
        document.body.prepend(bg);
    }
    // --- Lógica de Copyright (Actualización Automática del Año) ---
    const yearElements = document.querySelectorAll('#copyright-year, #year');
    yearElements.forEach(el => el.textContent = new Date().getFullYear());
});
