// scripts/worker_email.js
const nodemailer = require('nodemailer');

async function main() {
    // Leer inputs desde variables de entorno (inyectadas por el YML)
    const recipients = process.env.INPUT_RECIPIENTS;
    const subject = process.env.INPUT_SUBJECT;
    const htmlBase64 = process.env.INPUT_HTML_BASE64;
    
    if (!recipients || !subject || !htmlBase64) {
        console.error("❌ Faltan datos de entrada.");
        process.exit(1);
    }

    // Decodificar el HTML que viene en Base64 para que no se rompa
    const htmlContent = Buffer.from(htmlBase64, 'base64').toString('utf-8');

    const transporter = nodemailer.createTransport({
        service: 'gmail', // Aquí sí funciona el service: 'gmail' nativo
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    try {
        await transporter.sendMail({
            from: `"Sublimación Mary" <${process.env.EMAIL_USER}>`,
            to: recipients,
            subject: subject,
            html: htmlContent
        });
        console.log("✅ Correo enviado exitosamente desde GitHub Runner (Gmail Nativo).");
    } catch (error) {
        console.error("❌ Error enviando correo:", error);
        process.exit(1);
    }
}

main();
