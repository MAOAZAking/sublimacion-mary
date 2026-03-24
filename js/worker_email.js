const nodemailer = require('nodemailer');

async function main() {
    // Leer inputs desde variables de entorno (inyectadas por el YML)
    const recipients = process.env.INPUT_RECIPIENTS;
    const subject = process.env.INPUT_SUBJECT;
    const htmlBase64 = process.env.INPUT_HTML_BASE64;
    const attachmentsJson = process.env.INPUT_ATTACHMENTS;
    
    if (!recipients || !subject || !htmlBase64) {
        console.error("❌ Faltan datos de entrada.");
        process.exit(1);
    }

    // Decodificar el HTML que viene en Base64 para que no se rompa
    const htmlContent = Buffer.from(htmlBase64, 'base64').toString('utf-8');

    // --- MEJORA PARA HOTMAIL/OUTLOOK: Generar versión de texto plano ---
    // Los filtros de Microsoft bloquean correos que son 100% HTML sin respaldo de texto.
    const textContent = htmlContent
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Eliminar estilos CSS
        .replace(/<br\s*\/?>/gi, '\n') // Convertir <br> en saltos de línea
        .replace(/<\/p>/gi, '\n\n') // Convertir fin de párrafo en doble salto
        .replace(/<[^>]+>/g, '') // Eliminar cualquier otra etiqueta HTML
        .replace(/&nbsp;/g, ' ') // Caracteres especiales
        .replace(/\n\s*\n/g, '\n\n') // Limpiar espacios extra
        .trim();

    // Decodificar adjuntos si existen
    let attachments = [];
    if (attachmentsJson) {
        try { attachments = JSON.parse(attachmentsJson); }
        catch (e) { console.warn("Error parseando adjuntos:", e); }
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail', // Aquí sí funciona el service: 'gmail' nativo porque corre en GitHub, no en Render
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    try {
        await transporter.sendMail({
            from: `"Sublimación Mary" <${process.env.EMAIL_USER}>`,
            to: recipients,
            replyTo: process.env.EMAIL_USER, // Aumenta la confianza del filtro antispam
            subject: subject,
            text: textContent, // Versión texto plano (OBLIGATORIA para Hotmail)
            html: htmlContent,
            attachments: attachments, // Array de { filename, path }
            headers: {
                'X-Priority': '1 (Highest)',
                'X-MSMail-Priority': 'High',
                'Importance': 'High'
            }
        });
        console.log("✅ Correo enviado exitosamente desde GitHub Runner (Gmail Nativo).");
    } catch (error) {
        console.error("❌ Error enviando correo:", error);
        process.exit(1);
    }
}

main();