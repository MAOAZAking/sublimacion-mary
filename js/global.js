document.addEventListener('DOMContentLoaded', function() {
    // 1. Copyright Year Logic
    const copyrightSpan = document.getElementById('copyright-year');
    if (copyrightSpan) {
        copyrightSpan.textContent = new Date().getFullYear();
    }
});
