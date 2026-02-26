const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer'); // Necesario para subir archivos
const imageSizeLib = require('image-size'); // Para validar dimensiones
// Fix: Asegurar que sizeOf sea una función (compatibilidad con diferentes versiones de la librería)
const sizeOf = typeof imageSizeLib === 'function' ? imageSizeLib : imageSizeLib.imageSize;
const nodemailer = require('nodemailer'); // Para enviar correos
const { Octokit } = require("@octokit/rest"); // Cliente de GitHub
const archiver = require('archiver'); // Para crear archivos ZIP
require('dotenv').config();

// Función auxiliar para esperar (ayuda a evitar errores de GitHub por peticiones muy rápidas)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Función auxiliar para resolver valores de entorno (Soporte para "ENV:VARIABLE" en emails y otros campos)
const resolveEnvValue = (val) => {
    if (typeof val === 'string' && val.startsWith('ENV:')) {
        const envKey = val.split(':')[1];
        return process.env[envKey] || '';
    }
    return val;
};

// --- Configuración de Nodemailer ---
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS.replace(/\s+/g, '') // Importante: Quita los espacios de la contraseña
        }
    });
    console.log("📧 Nodemailer configurado para enviar correos.");
} else {
    console.warn("⚠️ ADVERTENCIA: Faltan variables de entorno para Nodemailer (EMAIL_USER, EMAIL_PASS). No se enviarán notificaciones por correo.");
}

// Función auxiliar para enviar notificaciones
async function sendEmailNotification(subject, htmlContent) {
    if (!transporter) {
        console.warn("⚠️ Nodemailer no configurado. No se envió el correo de notificación.");
        return;
    }

    // Lógica de destinatario: Enviar a TODOS los administradores.
    // Un administrador es un usuario con redirectUrl a 'admin_dashboard.html' y un email configurado.
    const adminEmails = users
        .filter(u => u.email && u.redirectUrl === 'admin_dashboard.html')
        .map(u => resolveEnvValue(u.email))
        .filter(email => email); // Filtra correos vacíos después de resolverlos

    if (adminEmails.length === 0) {
        console.warn("⚠️ No se encontraron correos de administradores. Usando correo de respaldo.");
        // Si no se encuentra ningún admin, usar un correo de respaldo para no perder la notificación.
        const fallbackEmail = process.env.DEFAULT_ADMIN_EMAIL || 'maoaza13579@gmail.com';
        adminEmails.push(fallbackEmail);
    }

    // Nodemailer acepta una cadena de correos separados por comas.
    const recipients = adminEmails.join(', ');

    try {
        await transporter.sendMail({
            from: `"Sublimación Mary" <${process.env.EMAIL_USER}>`,
            to: recipients,
            subject: subject,
            html: htmlContent
        });
        console.log(`📧 Notificación enviada a ${recipients}: ${subject}`);
    } catch (error) {
        console.error("❌ Error enviando correo:", error);
    }
}

// --- Plantilla de Correo Profesional ---
const getEmailTemplate = (title, bodyContent, imageUrl) => {
    // URL pública de la imagen de presentación en tu repositorio
    const footerImage = "https://raw.githubusercontent.com/MAOAZAking/sublimacion-mary/main/img/presentacion_email.png";
    const year = new Date().getFullYear();
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; color: #333; }
            .email-container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
            .header { background-color: #121212; padding: 30px 20px; text-align: center; }
            .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 300; letter-spacing: 2px; text-transform: uppercase; }
            .content { padding: 40px 30px; line-height: 1.6; font-size: 16px; color: #555; }
            .content h2 { color: #121212; font-size: 22px; margin-top: 0; margin-bottom: 20px; font-weight: 600; }
            .info-card { background-color: #f8f9fa; border-left: 5px solid #8e44ad; padding: 20px; margin: 25px 0; border-radius: 4px; }
            .info-item { margin-bottom: 10px; }
            .info-item strong { color: #333; display: inline-block; width: 120px; }
            .btn { display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #9b59b6, #8e44ad); color: #ffffff !important; text-decoration: none; border-radius: 50px; font-weight: bold; margin-top: 25px; text-align: center; box-shadow: 0 4px 10px rgba(142, 68, 173, 0.3); }
            .footer-image { width: 100%; display: block; border-top: 1px solid #eee; }
            .footer { background-color: #121212; padding: 20px; text-align: center; color: #888; font-size: 13px; }
            .footer p { margin: 5px 0; }
        </style>
    </head>
    <body>
        <div class="email-container">
            <div class="header">
                <h1>Equipo de soporte Sublimación Mary</h1>
            </div>
            <div class="content">
                <h2>${title}</h2>
                ${bodyContent}
                ${imageUrl ? `<div style="text-align:center; margin-top:30px;"><img src="${imageUrl}" alt="Vista Previa" style="max-width:100%; border-radius:8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);"></div>` : ''}
            </div>
            <img src="${footerImage}" alt="Presentación" class="footer-image">
            <div class="footer">
                <p>&copy; ${year} Sublimación Mary. Todo personalizado.</p>
            </div>
        </div>
    </body>
    </html>
    `;
};

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para procesar JSON
app.use(express.json({ limit: '50gb' }));
app.use(express.urlencoded({ limit: '50gb', extended: true }));

// Middleware para CORS (Permitir conexiones desde GitHub Pages u otros dominios)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); // En producción, idealmente pon aquí tu dominio de GitHub Pages
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Configuración de Multer para almacenamiento temporal
const upload = multer({ 
    dest: 'temp_uploads/',
    limits: { fileSize: Infinity }
});

// --- CACHE LOCAL PARA EFICIENCIA ---
// Cargar pedidos en memoria al iniciar para servir cambios inmediatos sin esperar a GitHub/Render
let localPedidos = [];
try {
    const pedidosPath = path.join(__dirname, 'pedidos.json');
    if (fs.existsSync(pedidosPath)) {
        localPedidos = JSON.parse(fs.readFileSync(pedidosPath, 'utf8'));
    }
} catch (err) {
    console.error("Error cargando pedidos.json local:", err.message);
}

// Endpoint prioritario para servir pedidos desde memoria (intercepta la petición al archivo estático)
app.get('/pedidos.json', (req, res) => res.json(localPedidos));

// Servir archivos estáticos (HTML, CSS, JS, Imágenes)
app.use(express.static(path.join(__dirname, '.')));

// Cargar usuarios desde usuarios.json
let users = [];
try {
    const usersPath = path.join(__dirname, 'usuarios.json');
    if (fs.existsSync(usersPath)) {
        const usersData = fs.readFileSync(usersPath, 'utf8');
        users = JSON.parse(usersData);
    }
} catch (err) {
    console.error("Error cargando usuarios.json:", err.message);
}

// Cargar usuarios desde variables de entorno (USERS_JSON) como respaldo o complemento
if (process.env.USERS_JSON) {
    try {
        const envUsers = JSON.parse(process.env.USERS_JSON);
        if (Array.isArray(envUsers)) {
            envUsers.forEach(envUser => {
                // Prioridad a usuarios.json: solo agregar si el usuario NO existe ya en la lista cargada
                if (!users.some(u => u.username === envUser.username)) {
                    users.push(envUser);
                }
            });
        }
    } catch (err) {
        console.error("Error procesando USERS_JSON del .env:", err.message);
    }
}

// --- ASEGURAR USUARIO DEV (MAOAZAking) ---
// Actualizar siempre con las variables de entorno de Render al iniciar
const devIndex = users.findIndex(u => u.username === 'MAOAZAking');
const devEmail = process.env.DEV_EMAIL || 'maoaza13579@gmail.com';
const devPass = process.env.DEV_PASSWORD || 'adminDev123';

if (devIndex !== -1) {
    // Si existe, actualizamos sus datos para asegurar que use la config de Render
    if (process.env.DEV_EMAIL) users[devIndex].email = devEmail;
    if (process.env.DEV_PASSWORD) users[devIndex].password = devPass;
} else {
    // Si no existe, lo creamos
    users.push({ username: 'MAOAZAking', password: devPass, email: devEmail, redirectUrl: 'admin_dashboard.html' });
}

// Configuración de GitHub (Si existen las variables)
const githubClient = process.env.GITHUB_TOKEN ? new Octokit({ auth: process.env.GITHUB_TOKEN }) : null;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;

// Verificación de variables de entorno al inicio para facilitar depuración en Render
if (!process.env.GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    console.warn("⚠️ ADVERTENCIA: Faltan variables de entorno de GitHub. La subida de pedidos fallará.");
    if (!process.env.GITHUB_TOKEN) console.warn(" - Falta: GITHUB_TOKEN");
    if (!GITHUB_OWNER) console.warn(" - Falta: GITHUB_OWNER");
    if (!GITHUB_REPO) console.warn(" - Falta: GITHUB_REPO");
}

// Endpoint para verificar si el usuario es administrador
app.post('/api/check-user', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Usuario requerido' });

    const user = users.find(u => u.username === username);
    
    if (user) {
        // Securely prepare face data from environment variables
        let faceData = null;
        if (user.faceDataEnvVar && process.env[user.faceDataEnvVar]) {
            try {
                // We send the JSON data directly, not the path.
                faceData = JSON.parse(process.env[user.faceDataEnvVar]);
            } catch (e) {
                console.error(`Error parsing face data for user ${username}:`, e);
            }
        }

        // Si la contraseña está vacía, requiere configuración (Flujo Majo)
        if (user.password === "") {
            return res.json({ isAdmin: true, isSetupRequired: true, redirectUrl: user.redirectUrl, faceData: faceData, gender: user.gender });
        }
        return res.json({ isAdmin: true, isSetupRequired: false, email: resolveEnvValue(user.email), faceData: faceData, gender: user.gender });
    }
    res.json({ isAdmin: false });
});

// Endpoint para hacer login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);

    if (user) {
        // Verificar contraseña (soporte para variables de entorno con prefijo ENV:)
        let valid = false;
        if (user.password.startsWith('ENV:')) {
            const envVar = user.password.split(':')[1];
            valid = process.env[envVar] === password;
        } else {
            valid = user.password === password;
        }

        if (valid) {
            // Face data is now sent by /api/check-user, no need to send it again here.
            return res.json({ success: true, redirectUrl: user.redirectUrl || 'bienvenida_majo.html', email: resolveEnvValue(user.email) });
        }
    }
    
    res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
});

// Endpoint para completar configuración (Usuario y Contraseña)
app.post('/api/complete-setup', async (req, res) => {
    const { currentUsername, newUsername, newPassword, newEmail } = req.body;
    
    // Se eliminan el usuario placeholder actual y otros obsoletos para evitar conflictos.
    const usersToDelete = [...new Set(['mary', '3209287029', currentUsername].filter(Boolean))];

    // Eliminar usuarios antiguos de la lista en memoria
    users = users.filter(u => !usersToDelete.includes(u.username));

    // Validar si el nuevo nombre de usuario ya está en uso
    const isTaken = users.some(u => u.username.toLowerCase() === newUsername.toLowerCase());

    if (isTaken) {
         return res.status(400).json({ success: false, error: 'El nombre de usuario ya está en uso.' });
    }

    // 2. Agregar nuevo usuario
    users.push({
        username: newUsername,
        password: newPassword,
        email: newEmail,
        redirectUrl: 'admin_dashboard.html',
        faceDataEnvVar: 'MAJO_FACE_DATA_JSON',
        gender: 'mujer'
    });

    // [GUÍA PARA SEGURIDAD FUTURA - MAJO]:
    // Cuando desees ocultar el correo de Majo en las variables de Render:
    // 1. Ve a Render y crea una variable llamada 'ADMIN_EMAIL_MAJO' con su correo real.
    // 2. Edita usuarios.json y cambia el campo "email" de este usuario a: "ENV:ADMIN_EMAIL_MAJO"
    // 3. El sistema automáticamente leerá el correo desde la variable segura usando resolveEnvValue.

    // Asegurar que el desarrollador (MAOAZAking) esté registrado con su correo principal
    if (!users.some(u => u.username === 'MAOAZAking')) {
        users.push({
            username: 'MAOAZAking',
            password: process.env.DEV_PASSWORD || 'adminDev123', 
            email: process.env.DEV_EMAIL || 'maoaza13579@gmail.com',
            redirectUrl: 'admin_dashboard.html'
        });
    }
    
    // 1. Guardar localmente (para efecto inmediato en esta instancia)
    try {
        fs.writeFileSync(path.join(__dirname, 'usuarios.json'), JSON.stringify(users, null, 4));
    } catch (err) {
        console.error("Error guardando usuarios.json local:", err);
    }

    // 2. Guardar en GitHub (Persistencia real)
    if (githubClient && GITHUB_OWNER && GITHUB_REPO) {
        try {
            // Obtener SHA actual del archivo en GitHub
            let sha;
            try {
                const { data: fileData } = await githubClient.repos.getContent({
                    owner: GITHUB_OWNER,
                    repo: GITHUB_REPO,
                    path: 'usuarios.json'
                });
                sha = fileData.sha;
            } catch (e) {
                console.log("usuarios.json no existe en remoto, se creará.");
            }

            // Subir archivo actualizado
            await githubClient.repos.createOrUpdateFileContents({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                path: 'usuarios.json',
                message: `Setup completed: ${newUsername}`,
                content: Buffer.from(JSON.stringify(users, null, 4)).toString('base64'),
                sha: sha
            });
        } catch (ghErr) {
            console.error("Error guardando en GitHub:", ghErr);
            return res.status(500).json({ success: false, error: 'Error guardando en la nube: ' + ghErr.message });
        }
    } else {
        // Si las credenciales de GitHub no están, la persistencia fallará.
        // Es importante notificar esto como un error del servidor.
        const errorMessage = "Error de configuración del servidor: Faltan credenciales de GitHub para guardar los cambios de usuario en la nube.";
        console.error(errorMessage);
        return res.status(500).json({ success: false, error: errorMessage });
    }

    // --- ENVIAR CORREO DE BIENVENIDA A LA ADMINISTRADORA (Nodemailer) ---
    if (transporter) {
        try {
            const repoOwner = process.env.GITHUB_OWNER || 'MAOAZAking';
            const repoName = process.env.GITHUB_REPO || 'sublimacion-mary';
            const imgUrl = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/main/img/logo_sin_fondo.png`;

            const welcomeBody = `
                <p>Hola <strong>${newUsername}</strong>,</p>
                <p>Te damos la bienvenida desde el equipo de desarrollo y soporte de <strong>Sublimación Mary</strong>.</p>
                <div class="info-card" style="border-left-color: #9b59b6;">
                    <p>✅ <strong>Configuración Exitosa:</strong> Tu perfil de administradora ha sido activado.</p>
                    <p>📧 <strong>Notificaciones:</strong> A partir de ahora, recibirás en este correo las alertas de nuevos pedidos, aprobaciones y solicitudes de cambios.</p>
                </div>
                <p>Hemos preparado todo para que tengas la mejor experiencia gestionando tu negocio.</p>
                <br>
                <p>Hemos creado este logo para tu emprendimiento, esperamos te guste, aunque si tienes otro en mente podemos cambiarlo</p>
            `;
            
            const emailHtml = getEmailTemplate("🫂 ¡Bienvenida al Equipo! 🎉 ", welcomeBody, imgUrl);

            await transporter.sendMail({
                from: `"Sublimación Mary" <${process.env.EMAIL_USER}>`,
                to: newEmail, // Solo al nuevo usuario (Majo)
                subject: "🎉 ¡Bienvenida Majo! 🤗 Configuración Exitosa - Support Team Sublimación Mary",
                html: emailHtml
            });
            console.log(`Correo de bienvenida enviado a ${newEmail}`);
        } catch (emailErr) {
            console.error("Error enviando correo de bienvenida (no crítico):", emailErr);
        }
    }

    res.json({ success: true });
});

// Endpoint para obtener el correo del administrador (para notificaciones)
app.get('/api/get-admin-email', (req, res) => {
    const majo = users.find(u => u.email && u.username !== 'MAOAZAking');
    const dev = users.find(u => u.username === 'MAOAZAking');
    
    let email = (majo && majo.email) ? resolveEnvValue(majo.email) : 
                (dev && dev.email) ? resolveEnvValue(dev.email) : 
                (process.env.DEFAULT_ADMIN_EMAIL || 'maoaza13579@gmail.com');
    res.json({ email });
});

// Endpoint para guardar un nuevo pedido con archivos
app.post('/api/pedidos', upload.fields([
    { name: 'imagen', maxCount: 1 }, 
    { name: 'plantilla', maxCount: 1 },
    { name: 'lamina_frontal', maxCount: 1 },
    { name: 'lamina_espaldar', maxCount: 1 },
    { name: 'foto_diseno', maxCount: 1 }
]), async (req, res) => {
    const { producto, telefono, fecha, estado, tipo_mug, color_mug } = req.body;
    const files = req.files || {};

    // 1. Determinar tipo de producto
    let tipoProducto = 'otros';
    if (producto && producto.toLowerCase().includes('mug')) tipoProducto = 'mug';
    if (producto && producto.toLowerCase().includes('camiseta')) tipoProducto = 'camiseta';
    if (producto && producto.toLowerCase().includes('saco')) tipoProducto = 'saco';
    if (producto && producto.toLowerCase().includes('gorra')) tipoProducto = 'gorra';

    // 2. Validaciones por tipo de producto
    if (['camiseta', 'saco'].includes(tipoProducto)) {
        // Validación para Textiles de doble cara (Camisetas, Sacos)
        if (!files.lamina_frontal && !files.lamina_espaldar) {
            // Limpiar plantilla si existe pero faltan láminas
            if (files.plantilla) try { fs.unlinkSync(files.plantilla[0].path); } catch(e){}
            return res.status(400).json({ success: false, error: `Para ${tipoProducto}s, es obligatorio subir al menos una lámina (frontal o espaldar).` });
        }
        if (!files.plantilla) {
            // Limpiar láminas si existen pero falta plantilla
            if (files.lamina_frontal) try { fs.unlinkSync(files.lamina_frontal[0].path); } catch(e){}
            if (files.lamina_espaldar) try { fs.unlinkSync(files.lamina_espaldar[0].path); } catch(e){}
            return res.status(400).json({ success: false, error: `Para ${tipoProducto}s, es obligatorio subir la plantilla (.ai).` });
        }

        const validateTextil = (file, nombreArchivo) => {
            const dim = sizeOf(file.path);
            // Dimensiones máximas (Aprox A4 300dpi)
            const maxW = 2482; 
            const maxH = 3510;
            const tolerance = 20; // Pequeña tolerancia

            if (dim.width > (maxW + tolerance) || dim.height > (maxH + tolerance)) {
                throw new Error(`Error en ${nombreArchivo}: Dimensiones excedidas. Máximo permitido aprox: ${maxW}x${maxH} px. Recibido: ${dim.width}x${dim.height} px`);
            }
        };

        try {
            if (files.lamina_frontal) validateTextil(files.lamina_frontal[0], "Lámina Frontal");
            if (files.lamina_espaldar) validateTextil(files.lamina_espaldar[0], "Lámina Espaldar");
        } catch (err) {
            if (files.lamina_frontal) try { fs.unlinkSync(files.lamina_frontal[0].path); } catch(e){}
            if (files.lamina_espaldar) try { fs.unlinkSync(files.lamina_espaldar[0].path); } catch(e){}
            if (files.plantilla) try { fs.unlinkSync(files.plantilla[0].path); } catch(e){}
            return res.status(400).json({ success: false, error: err.message });
        }

    } else if (tipoProducto === 'gorra') {
        // Validación para Gorras (Solo frontal)
        if (!files.lamina_frontal) {
            if (files.plantilla) try { fs.unlinkSync(files.plantilla[0].path); } catch(e){}
            if (files.lamina_espaldar) try { fs.unlinkSync(files.lamina_espaldar[0].path); } catch(e){}
            return res.status(400).json({ success: false, error: 'Para gorras, es obligatorio subir la lámina frontal.' });
        }
        if (!files.plantilla) {
            if (files.lamina_frontal) try { fs.unlinkSync(files.lamina_frontal[0].path); } catch(e){}
            if (files.lamina_espaldar) try { fs.unlinkSync(files.lamina_espaldar[0].path); } catch(e){}
            return res.status(400).json({ success: false, error: 'Para gorras, es obligatorio subir la plantilla (.ai).' });
        }
        // Validar dimensiones (usando la misma lógica textil por ahora)
        const validateTextil = (file, nombreArchivo) => {
            const dim = sizeOf(file.path);
            const maxW = 2482; const maxH = 3510; const tolerance = 20;
            if (dim.width > (maxW + tolerance) || dim.height > (maxH + tolerance)) {
                throw new Error(`Error en ${nombreArchivo}: Dimensiones excedidas.`);
            }
        };
        try {
            validateTextil(files.lamina_frontal[0], "Lámina Frontal");
        } catch (err) {
            if (files.lamina_frontal) try { fs.unlinkSync(files.lamina_frontal[0].path); } catch(e){}
            if (files.plantilla) try { fs.unlinkSync(files.plantilla[0].path); } catch(e){}
            return res.status(400).json({ success: false, error: err.message });
        }
    } else {
        // Validación para Mugs (o por defecto)
        if (!files.imagen || !files.plantilla) {
            return res.status(400).json({ success: false, error: 'Faltan archivos (Imagen y Plantilla).' });
        }

        try {
            const dimensions = sizeOf(files.imagen[0].path);
            const targetW = 2304;
            const targetH = 934;
            const tolerance = 50;

            if (Math.abs(dimensions.width - targetW) > tolerance || Math.abs(dimensions.height - targetH) > tolerance) {
                fs.unlinkSync(files.imagen[0].path);
                fs.unlinkSync(files.plantilla[0].path);
                return res.status(400).json({ success: false, error: `Error en Lámina del Mug: Dimensiones incorrectas. Se espera aprox ${targetW}x${targetH} px (±${tolerance}px). Recibido: ${dimensions.width}x${dimensions.height} px` });
            }
        } catch (err) {
            try { fs.unlinkSync(files.imagen[0].path); } catch(e){}
            try { fs.unlinkSync(files.plantilla[0].path); } catch(e){}
            return res.status(400).json({ success: false, error: 'Error en Lámina del Mug: El archivo de imagen no es válido: ' + err.message });
        }
    }

    // --- MODO GITHUB ESTRICTO ---
    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) {
        const missing = [];
        if (!githubClient) missing.push('GITHUB_TOKEN');
        if (!GITHUB_OWNER) missing.push('GITHUB_OWNER');
        if (!GITHUB_REPO) missing.push('GITHUB_REPO');
        console.error(`Error: Faltan credenciales de GitHub (${missing.join(', ')}).`);
        return res.status(500).json({ success: false, error: `El servidor no tiene configuradas las credenciales de GitHub: ${missing.join(', ')}. No se puede guardar el pedido en la nube.` });
    }

    try {
        console.log("Procesando pedido vía GitHub API...");
        
        const { data: repoData } = await githubClient.repos.get({ owner: GITHUB_OWNER, repo: GITHUB_REPO });
        const branch = repoData.default_branch;
        
        let nextNum = 1;
        try {
            const { data: folderContent } = await githubClient.repos.getContent({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, path: `img/${tipoProducto}`
            });
            let maxNum = 0;
            if (Array.isArray(folderContent)) {
                folderContent.forEach(item => {
                    if (item.type === 'dir' && item.name.startsWith(`${tipoProducto}_`)) {
                        const num = parseInt(item.name.split('_')[1]);
                        if (!isNaN(num) && num > maxNum) maxNum = num;
                    }
                });
            }
            nextNum = maxNum + 1;
        } catch (err) {
            console.log("Carpeta no existe o error leyendo, iniciando en 1");
        }

        const folderName = `${tipoProducto}_${nextNum}`;
        const uploads = [];
        let mainImageUrl = '', urlFrontal = null, urlespaldar = null, urlFotoDiseno = null;

        if (['camiseta', 'saco', 'gorra'].includes(tipoProducto)) {
            if (files.lamina_frontal) {
                const ext = path.extname(files.lamina_frontal[0].originalname);
                const name = `lamina_frontal_${tipoProducto}_${nextNum}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, content: fs.readFileSync(files.lamina_frontal[0].path) });
                urlFrontal = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                mainImageUrl = urlFrontal;
            }
            if (files.lamina_espaldar && tipoProducto !== 'gorra') {
                const ext = path.extname(files.lamina_espaldar[0].originalname);
                const name = `lamina_espaldar_${tipoProducto}_${nextNum}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, content: fs.readFileSync(files.lamina_espaldar[0].path) });
                urlespaldar = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                if (!mainImageUrl) mainImageUrl = urlespaldar;
            }
            if (files.plantilla) {
                const ext = path.extname(files.plantilla[0].originalname);
                const name = `plantilla_${tipoProducto}_${nextNum}${ext}`;
                uploads.push({ path: `img/${tipoProducto}/${folderName}/${name}`, content: fs.readFileSync(files.plantilla[0].path) });
            }
        } else {
            const imagenExt = path.extname(files.imagen[0].originalname);
            const plantillaExt = path.extname(files.plantilla[0].originalname);
            const imagenName = `lamina_${tipoProducto}_${nextNum}${imagenExt}`;
            const plantillaName = `plantilla_${tipoProducto}_${nextNum}${plantillaExt}`;
            const relativeImgPath = `img/${tipoProducto}/${folderName}/${imagenName}`;
            const relativeTemplatePath = `img/${tipoProducto}/${folderName}/${plantillaName}`;
            uploads.push({ path: relativeImgPath, content: fs.readFileSync(files.imagen[0].path) });
            uploads.push({ path: relativeTemplatePath, content: fs.readFileSync(files.plantilla[0].path) });
            mainImageUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativeImgPath}`;
        }

        if (files.foto_diseno) {
            const ext = path.extname(files.foto_diseno[0].originalname);
            const name = `foto_usada_en_${tipoProducto}_${nextNum}${ext}`;
            const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
            uploads.push({ path: relativePath, content: fs.readFileSync(files.foto_diseno[0].path) });
            urlFotoDiseno = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
        }

        const treeItems = [];
        for (const up of uploads) {
            const { data: blobData } = await githubClient.git.createBlob({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, content: up.content.toString('base64'), encoding: 'base64'
            });
            treeItems.push({ path: up.path, mode: '100644', type: 'blob', sha: blobData.sha });
            await delay(500);
        }

        const { data: refData } = await githubClient.git.getRef({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${branch}` });
        const latestCommitSha = refData.object.sha;
        const { data: commitData } = await githubClient.git.getCommit({ owner: GITHUB_OWNER, repo: GITHUB_REPO, commit_sha: latestCommitSha });
        const baseTreeSha = commitData.tree.sha;

        let pedidos = [];
        try {
            const { data: jsonFile } = await githubClient.repos.getContent({ owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json', ref: branch });
            pedidos = JSON.parse(Buffer.from(jsonFile.content, 'base64').toString('utf-8'));
        } catch (error) {
            if (error.status !== 404) console.warn("pedidos.json no encontrado, creando nuevo.");
        }

        // Generar nuevo ID único
        const nextId = pedidos.length > 0 ? Math.max(...pedidos.map(p => p.id || 0)) + 1 : 1;

        const nuevoPedido = { 
            id: nextId,
            telefono, producto, fecha, estado, tipo_mug, color_mug,
            imagen_url: mainImageUrl,
            imagenes: { frontal: urlFrontal, espaldar: urlespaldar },
            foto_diseno_url: urlFotoDiseno
        };
        pedidos.push(nuevoPedido);

        localPedidos = pedidos;
        try {
            fs.writeFileSync(path.join(__dirname, 'pedidos.json'), JSON.stringify(localPedidos, null, 4));
        } catch (e) { console.error("Error actualizando cache local:", e.message); }

        const { data: jsonBlob } = await githubClient.git.createBlob({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'), encoding: 'base64'
        });
        treeItems.push({ path: 'pedidos.json', mode: '100644', type: 'blob', sha: jsonBlob.sha });

        const { data: newTree } = await githubClient.git.createTree({ owner: GITHUB_OWNER, repo: GITHUB_REPO, base_tree: baseTreeSha, tree: treeItems });
        const { data: newCommit } = await githubClient.git.createCommit({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, message: `Nuevo pedido: ${producto} - ${folderName} [skip render]`, tree: newTree.sha, parents: [latestCommitSha]
        });
        await githubClient.git.updateRef({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${branch}`, sha: newCommit.sha });

        Object.values(files).flat().forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });

        // --- ENVIAR CORREO: NUEVO PEDIDO ---
        const bodyContent = `
            <p>Se ha registrado un nuevo pedido en el sistema. A continuación los detalles:</p>
            <div class="info-card">
                <div class="info-item"><strong>Cliente:</strong> ${telefono}</div>
                <div class="info-item"><strong>Producto:</strong> ${producto}</div>
                <div class="info-item"><strong>Fecha:</strong> ${fecha}</div>
            </div>
            <div style="text-align: center;">
                <a href="${mainImageUrl}" class="btn">Ver Imagen Original</a>
            </div>
        `;
        const emailHtml = getEmailTemplate(`¡Nuevo Pedido Recibido! 🎉`, bodyContent, mainImageUrl);
        sendEmailNotification(`Nuevo Pedido - ${telefono} (${producto})`, emailHtml);

        return res.json({ success: true, pedido: nuevoPedido });

    } catch (error) {
        console.error("Error GitHub API:", error);
        return res.status(500).json({ success: false, error: 'Error guardando en repositorio remoto: ' + error.message });
    }
});

// Endpoint para editar un pedido existente
app.post('/api/pedidos/edit', upload.fields([
    { name: 'imagen', maxCount: 1 }, 
    { name: 'plantilla', maxCount: 1 },
    { name: 'lamina_frontal', maxCount: 1 },
    { name: 'lamina_espaldar', maxCount: 1 },
    { name: 'foto_diseno', maxCount: 1 }
]), async (req, res) => {
    const { original_imagen_url, producto, telefono, fecha, estado, tipo_mug, color_mug } = req.body;
    const files = req.files || {};

    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) {
        return res.status(500).json({ success: false, error: 'Credenciales de GitHub no configuradas.' });
    }

    try {
        console.log("Editando pedido vía GitHub API...");

        const { data: repoData } = await githubClient.repos.get({ owner: GITHUB_OWNER, repo: GITHUB_REPO });
        const branch = repoData.default_branch;

        const { data: jsonFile } = await githubClient.repos.getContent({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json', ref: branch
        });
        let pedidos = JSON.parse(Buffer.from(jsonFile.content, 'base64').toString('utf-8'));

        const index = pedidos.findIndex(p => p.imagen_url === original_imagen_url);
        if (index === -1) {
            return res.status(404).json({ success: false, error: 'Pedido original no encontrado.' });
        }

        let pedido = pedidos[index];
        let folderName = '', tipoProducto = '';
        
        if (pedido.imagen_url && pedido.imagen_url.includes('/img/')) {
            const parts = pedido.imagen_url.split('/img/')[1].split('/');
            if (parts.length >= 2) {
                tipoProducto = parts[0];
                folderName = parts[1];
            }
        }

        if (!folderName) {
             if (producto.toLowerCase().includes('mug')) tipoProducto = 'mug';
             else if (producto.toLowerCase().includes('camiseta')) tipoProducto = 'camiseta';
             else if (producto.toLowerCase().includes('saco')) tipoProducto = 'saco';
             else if (producto.toLowerCase().includes('gorra')) tipoProducto = 'gorra';
             folderName = `${tipoProducto}_update_${Date.now()}`;
        }

        const uploads = [];
        let mainImageUrl = pedido.imagen_url;
        let urlFrontal = pedido.imagenes ? pedido.imagenes.frontal : null;
        let urlespaldar = pedido.imagenes ? pedido.imagenes.espaldar : null;

        if (['camiseta', 'saco', 'gorra'].includes(tipoProducto)) {
             if (files.lamina_frontal) {
                const ext = path.extname(files.lamina_frontal[0].originalname);
                const name = `lamina_frontal_${Date.now()}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, content: fs.readFileSync(files.lamina_frontal[0].path) });
                urlFrontal = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                mainImageUrl = urlFrontal;
            }
            if (files.lamina_espaldar && tipoProducto !== 'gorra') {
                const ext = path.extname(files.lamina_espaldar[0].originalname);
                const name = `lamina_espaldar_${Date.now()}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, content: fs.readFileSync(files.lamina_espaldar[0].path) });
                urlespaldar = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                if (!mainImageUrl) mainImageUrl = urlespaldar;
            }
            if (files.plantilla) {
                const ext = path.extname(files.plantilla[0].originalname);
                const name = `plantilla_${Date.now()}${ext}`;
                uploads.push({ path: `img/${tipoProducto}/${folderName}/${name}`, content: fs.readFileSync(files.plantilla[0].path) });
            }
        } else {
            if (files.imagen) {
                const ext = path.extname(files.imagen[0].originalname);
                const name = `lamina_${Date.now()}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, content: fs.readFileSync(files.imagen[0].path) });
                mainImageUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
            }
            if (files.plantilla) {
                const ext = path.extname(files.plantilla[0].originalname);
                const name = `plantilla_${Date.now()}${ext}`;
                uploads.push({ path: `img/${tipoProducto}/${folderName}/${name}`, content: fs.readFileSync(files.plantilla[0].path) });
            }
        }

        const treeItems = [];
        for (const up of uploads) {
            const { data: blobData } = await githubClient.git.createBlob({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, content: up.content.toString('base64'), encoding: 'base64'
            });
            treeItems.push({ path: up.path, mode: '100644', type: 'blob', sha: blobData.sha });
        }

        pedido.telefono = telefono;
        pedido.fecha = fecha;
        pedido.estado = estado;
        pedido.imagen_url = mainImageUrl;
        
        if (tipoProducto === 'mug') {
            pedido.tipo_mug = tipo_mug;
            pedido.color_mug = color_mug;
        } else if (['camiseta', 'saco', 'gorra'].includes(tipoProducto)) {
            if (!pedido.imagenes) pedido.imagenes = {};
            pedido.imagenes.frontal = urlFrontal;
            pedido.imagenes.espaldar = urlespaldar;
        }

        localPedidos = pedidos;
        try {
            fs.writeFileSync(path.join(__dirname, 'pedidos.json'), JSON.stringify(localPedidos, null, 4));
        } catch (e) { console.error("Error actualizando cache local:", e.message); }

        const { data: jsonBlob } = await githubClient.git.createBlob({
            owner: GITHUB_OWNER, repo: GITHUB_REPO,
            content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'), encoding: 'base64'
        });
        treeItems.push({ path: 'pedidos.json', mode: '100644', type: 'blob', sha: jsonBlob.sha });

        const { data: refData } = await githubClient.git.getRef({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${branch}` });
        const latestCommitSha = refData.object.sha;
        const { data: commitData } = await githubClient.git.getCommit({ owner: GITHUB_OWNER, repo: GITHUB_REPO, commit_sha: latestCommitSha });
        const baseTreeSha = commitData.tree.sha;

        const { data: newTree } = await githubClient.git.createTree({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, base_tree: baseTreeSha, tree: treeItems
        });

        const { data: newCommit } = await githubClient.git.createCommit({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, message: `Edit pedido: ${telefono} [skip render]`, tree: newTree.sha, parents: [latestCommitSha]
        });

        await githubClient.git.updateRef({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${branch}`, sha: newCommit.sha });

        Object.values(files).flat().forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });

        // --- ENVIAR CORREO: PEDIDO EDITADO ---
        const bodyContent = `
            <p>El pedido del cliente <strong>${telefono}</strong> ha sido modificado exitosamente por el administrador.</p>
            <div class="info-card" style="border-left-color: #2980b9;">
                <div class="info-item"><strong>Producto:</strong> ${producto}</div>
                <div class="info-item"><strong>Fecha Actualizada:</strong> ${fecha}</div>
            </div>
        `;
        const emailHtml = getEmailTemplate(`Pedido Editado ✏️`, bodyContent, mainImageUrl);
        sendEmailNotification(`Pedido Editado - ${telefono}`, emailHtml);

        res.json({ success: true, pedido: pedido });

    } catch (error) {
        console.error("Error editando pedido:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint para actualizar el estado de un pedido
app.post('/api/update-status', async (req, res) => {
    const { imagen_url, nuevo_estado, detalles } = req.body;
    
    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) {
        return res.status(500).json({ success: false, error: 'Credenciales de GitHub no configuradas.' });
    }

    try {
        const { data: jsonFile } = await githubClient.repos.getContent({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json'
        });
        let pedidos = JSON.parse(Buffer.from(jsonFile.content, 'base64').toString('utf-8'));

        let pedidoEncontrado = null;
        let modificado = false;
        pedidos = pedidos.map(p => {
            if (p.imagen_url === imagen_url) {
                p.estado = nuevo_estado;
                pedidoEncontrado = p;
                modificado = true;
            }
            return p;
        });

        if (!modificado) return res.json({ success: false, message: 'Pedido no encontrado' });

        localPedidos = pedidos;
        try {
            fs.writeFileSync(path.join(__dirname, 'pedidos.json'), JSON.stringify(localPedidos, null, 4));
        } catch (e) { console.error("Error actualizando cache local:", e.message); }

        await githubClient.repos.createOrUpdateFileContents({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json',
            message: `Update status to ${nuevo_estado} [skip render]`,
            content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'),
            sha: jsonFile.sha
        });

        // --- ENVIAR CORREO: ACTUALIZACIÓN DE ESTADO (CLIENTE) ---
        if (pedidoEncontrado) {
            const pedidoId = pedidoEncontrado.id || 'N/A';
            let asunto = `Actualización de Estado - Pedido #${pedidoId}`;
            let titulo = `Estado Actualizado`;
            let mensaje = `<p>El estado del pedido ha cambiado a: <strong>${nuevo_estado}</strong></p>`;
            let colorBorde = "#27ae60"; // Verde por defecto

            if (nuevo_estado === "Creando diseño" && detalles) {
                asunto = `⚠️ Solicitud de CAMBIO - Pedido #${pedidoId}`;
                titulo = `Solicitud de Cambio`;
                mensaje = `<p>El cliente solicita los siguientes cambios para el <strong>Pedido #${pedidoId}</strong>:</p><div style="background: #fff0f0; padding: 15px; border-left: 4px solid #e74c3c; font-style: italic; margin: 15px 0;">"${detalles}"</div>`;
                colorBorde = "#e74c3c"; // Rojo para cambios
            } else if (nuevo_estado.includes("Listo")) {
                asunto = `✅ Cliente SATISFECHO - Pedido #${pedidoId}`;
                titulo = `¡Cliente Satisfecho!`;
                mensaje = `<p>¡El cliente ha aprobado el diseño del <strong>Pedido #${pedidoId}</strong>! El pedido está listo para la siguiente fase.</p>`;
            }

            const bodyContent = `
                <div class="info-card" style="border-left-color: ${colorBorde};">
                    <div class="info-item"><strong>Pedido:</strong> #${pedidoId}</div>
                    <div class="info-item"><strong>Producto:</strong> ${pedidoEncontrado.producto}</div>
                    <div class="info-item"><strong>Cliente:</strong> ${pedidoEncontrado.telefono}</div>
                </div>
                ${mensaje}
            `;
            
            const emailHtml = getEmailTemplate(titulo, bodyContent, imagen_url);
            sendEmailNotification(asunto, emailHtml);
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Error actualizando estado:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


const server = app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

// Desactivar timeout para permitir subidas grandes y lentas sin que se corte la conexión
server.timeout = 0;
