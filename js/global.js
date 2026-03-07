document.addEventListener('DOMContentLoaded', function() {
    // 1. Copyright Year Logic
    const copyrightSpan = document.getElementById('copyright-year');
    if (copyrightSpan) {
        copyrightSpan.textContent = new Date().getFullYear();
    }

    // 2. Background Logo Logic
    // Solo agregamos el fondo si no existe ya (por si acaso)
    if (!document.getElementById('background-logo')) {
        const bg = document.createElement('div');
        bg.id = 'background-logo';
        document.body.prepend(bg);
    }
    
    const bg = document.getElementById('background-logo');

    function updateBg() {
        const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 2) || window.innerWidth < 768;
        if (isMobile) {
            if (window.innerHeight > window.innerWidth) {
                bg.style.backgroundSize = "60vw auto"; // Vertical: 60% del ancho
            } else {
                bg.style.backgroundSize = "auto 60vh"; // Horizontal: 60% del alto
            }
        } else {
            bg.style.backgroundSize = "auto 85vh"; // Escritorio: 85% del alto
        }
    }
    
    // Ejecutar inmediatamente
    updateBg();

    // Listeners para actualizar
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 2) || window.innerWidth < 768) {
        setInterval(updateBg, 1000); // Móvil: Actualizar cada segundo
    } else {
        window.addEventListener('resize', updateBg); // Escritorio: Solo al redimensionar
    }
});

// 3. Loader Logic (Window Load)
window.addEventListener('load', function() {
    const loader = document.getElementById('global-loader');
    if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => { loader.style.display = 'none'; }, 500);
    }
});
