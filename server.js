const express = require('express');
const https = require('https'); // Necesario para la API de Brevo
const http = require('http'); // Necesario para la API de geolocalización
const path = require('path');
const fs = require('fs');
const multer = require('multer'); // Necesario para subir archivos
const imageSizeLib = require('image-size'); // Para validar dimensiones
// Fix: Asegurar que sizeOf sea una función (compatibilidad con diferentes versiones de la librería)
const sizeOf = typeof imageSizeLib === 'function' ? imageSizeLib : imageSizeLib.imageSize;
const { Octokit } = require("@octokit/rest"); // Cliente de GitHub
const archiver = require('archiver'); // Para crear archivos ZIP
const dotenv = require('dotenv');
dotenv.config();

// Función auxiliar para esperar (ayuda a evitar errores de GitHub por peticiones muy rápidas)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Función auxiliar para obtener información de IP
function getIpInfo(ip) {
    // Limpiar IP si es de IPv6-mapeado-a-IPv4
    if (ip.substr(0, 7) == "::ffff:") {
      ip = ip.substr(7);
    }
    return new Promise((resolve) => {
        // API gratuita sin clave
        const url = `http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,isp,org,query`;
        http.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } 
                catch (e) { resolve({ status: 'fail', message: 'Invalid JSON response' }); }
            });
        }).on('error', (e) => resolve({ status: 'fail', message: 'Network error: ' + e.message }));
    });
}

// Función auxiliar para obtener información de IP desde MaxMind GeoLite2
function getIpInfoMaxMind(ip) {
    const accountId = process.env.MAXMIND_ACCOUNT_ID;
    const licenseKey = process.env.MAXMIND_LICENSE_KEY;

    // Si no hay credenciales, no intentar la llamada
    if (!accountId || !licenseKey) {
        return Promise.resolve(null);
    }

    // Limpiar IP si es de IPv6-mapeado-a-IPv4
    if (ip.substr(0, 7) == "::ffff:") {
      ip = ip.substr(7);
    }
    
    // IPs locales no se pueden consultar
    if (ip === '127.0.0.1' || ip === '::1') {
        return Promise.resolve({ code: 'LOCAL_IP_ADDRESS', error: 'IP local no consultable.' });
    }

    return new Promise((resolve) => {
        const options = {
            hostname: 'geolite.info.x-maxmind.com',
            path: `/geolite/v2.1/city/${encodeURIComponent(ip)}`,
            method: 'GET',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(accountId + ':' + licenseKey).toString('base64'),
                'User-Agent': 'sublimacion-mary-server/1.0'
            }
        };

        https.get(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } 
                catch (e) { resolve({ code: 'JSON_PARSE_ERROR', error: 'Respuesta JSON inválida de MaxMind' }); }
            });
        }).on('error', (e) => resolve({ code: 'NETWORK_ERROR', error: 'Error de red: ' + e.message }));
    });
}

// Función auxiliar para resolver valores de entorno (Soporte para "ENV:VARIABLE" en emails y otros campos)
const resolveEnvValue = (val) => {
    if (typeof val === 'string' && val.startsWith('ENV:')) {
        const envKey = val.split(':')[1];
        return process.env[envKey] || '';
    }
    return val;
};

// Función auxiliar para enviar notificaciones
async function sendEmailNotification(subject, htmlContent) {
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

    // Usar la función centralizada de despacho
    await dispatchEmail(adminEmails, subject, htmlContent);
}

// --- Función Centralizada de Envío (Estrategia: GitHub -> Brevo) ---
async function dispatchEmail(recipientsArray, subject, htmlContent) {
    const recipientsString = recipientsArray.join(', ');
    let enviado = false;

    // INTENTO 1: GitHub Action (Principal - Gmail Nativo via Runner)
    if (githubClient) {
        try {
            // Codificar HTML a Base64 para pasarlo seguro por la API de GitHub
            const htmlBase64 = Buffer.from(htmlContent).toString('base64');
            
            await githubClient.actions.createWorkflowDispatch({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                workflow_id: 'enviar_notificacion.yml',
                ref: 'main', // Asegúrate que tu rama principal se llame 'main'
                inputs: {
                    recipients: recipientsString,
                    subject: subject,
                    html_base64: htmlBase64
                }
            });
            console.log(`🚀 Solicitud enviada a GitHub Action (Gmail Nativo) para: ${recipientsString}`);
            enviado = true; 
        } catch (error) {
            console.error("❌ Falló el método principal (GitHub Action):", error.message);
        }
    }

    // INTENTO 2: Brevo (Respaldo)
    if (!enviado && process.env.BREVO_API_KEY) {
        console.log("🔄 Usando Brevo como último respaldo...");
        await sendEmailViaBrevo(recipientsArray, subject, htmlContent);
    } else if (!enviado) {
        console.error("❌ No se pudo enviar el correo por ningún método.");
    }
}

// --- Función para enviar vía Brevo (API HTTP) ---
function sendEmailViaBrevo(recipientsArray, subject, htmlContent) {
    return new Promise((resolve, reject) => {
        // Configuración para Brevo
        const data = JSON.stringify({
            sender: { name: "Sublimación Mary", email: "team.sublimacion.mary@gmail.com" }, // Remitente verificado
            to: recipientsArray.map(email => ({ email: email })), // Formato Brevo: array de objetos
            subject: subject,
            htmlContent: htmlContent,
            // Encabezados para marcar como IMPORTANTE y tratar de evitar la pestaña Promociones
            headers: {
                "X-Priority": "1", // 1 = Alta prioridad
                "X-MSMail-Priority": "High",
                "Importance": "High"
            }
        });

        const options = {
            hostname: 'api.brevo.com',
            path: '/v3/smtp/email',
            method: 'POST',
            headers: {
                'api-key': process.env.BREVO_API_KEY,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => responseBody += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`📧 Notificación enviada vía Brevo a: ${recipientsArray.join(', ')}`);
                } else {
                    console.error(`❌ Error Brevo API (${res.statusCode}):`, responseBody);
                }
                resolve();
            });
        });

        req.on('error', (error) => { console.error("❌ Error de red con Brevo:", error); resolve(); });
        req.write(data);
        req.end();
    });
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
                <h1>Support Sublimación Mary</h1>
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

// --- Cargar Configuración de Usuarios ---
// Se carga la configuración "cruda" para poder resolver los valores de .env sobre la marcha.
let usersConfig = [];
try {
    const usersPath = path.join(__dirname, 'usuarios.json');
    if (fs.existsSync(usersPath)) {
        const usersData = fs.readFileSync(usersPath, 'utf8');
        usersConfig = JSON.parse(usersData);
        console.log("✅ Configuración de usuarios cargada desde usuarios.json");
    }
} catch (err) {
    console.error("❌ Error crítico al cargar usuarios.json:", err.message);
}

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

// Endpoint prioritario para servir pedidos desde memoria (intercepta la petición al archivo estático)
app.get('/pedidos.json', (req, res) => res.json(localPedidos));

// Servir archivos estáticos (HTML, CSS, JS, Imágenes)
app.use(express.static(path.join(__dirname, '.')));

// Endpoint para verificar si el usuario es administrador
app.post('/api/check-user', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Usuario requerido' });

    const user = usersConfig.find(u => resolveEnvValue(u.username) === username);
    
    if (user) {
        // Securely prepare face data from environment variables
        let faceData = null;
        // FIX: Fallback inteligente. Si no tiene variable asignada, busca una basada en el nombre
        const envVarName = user.faceDataEnvVar || `${user.username.toUpperCase()}_FACE_DATA_JSON`;
        console.log(`🔍 Buscando datos faciales en variable: ${envVarName}`);
        
        let rawJson = process.env[envVarName];

        // 1. Intentar parsear lo que ya cargó dotenv (si existe)
        if (rawJson) {
            try {
                faceData = JSON.parse(rawJson);
            } catch (e) {
                console.warn(`⚠️ Error parseando process.env['${envVarName}']. Posiblemente truncado. Intentando lectura manual...`);
                faceData = null; // Resetear para intentar lectura manual
            }
        }

        // 2. Si falló o no existe, y estamos en local, intentar leer .env manualmente (Soporte multilínea sin comillas)
        if (!faceData && fs.existsSync(path.join(__dirname, '.env'))) {
            try {
                const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
                // Busca: NOMBRE_VAR={...} capturando todo el bloque JSON hasta el cierre }
                const regex = new RegExp(`^${envVarName}\\s*=\\s*({[\\s\\S]*?})`, 'm');
                const match = envContent.match(regex);
                if (match) {
                    rawJson = match[1];
                    try {
                        faceData = JSON.parse(rawJson);
                        console.log("✅ Datos recuperados correctamente mediante lectura manual del .env");
                    } catch (e) {
                        console.error("❌ Error parseando JSON manual:", e.message);
                    }
                }
            } catch (e) { console.error("Error leyendo .env local:", e); }
        }

        if (faceData) {
            console.log(`✅ Datos faciales listos para: ${username}`);
        } else {
            if (rawJson) console.error("⚠️ Contenido crudo final que falló:", rawJson);
            console.warn(`⚠️ No se encontraron datos faciales válidos para ${username} en la variable: ${envVarName}`);
        }

        // Si la contraseña está vacía, requiere configuración (Flujo Majo)
        if (user.password === "") {
            return res.json({ isAdmin: true, isSetupRequired: true, redirectUrl: user.redirectUrl, faceData: faceData, gender: user.gender });
        }
        // Devolver también el nombre completo para los registros
        if (user.name) {
            return res.json({ isAdmin: true, isSetupRequired: false, email: resolveEnvValue(user.email), faceData: faceData, gender: user.gender, name: user.name });
        }
        return res.json({ isAdmin: true, isSetupRequired: false, email: resolveEnvValue(user.email), faceData: faceData, gender: user.gender });
    }
    res.json({ isAdmin: false });
});

// Endpoint para hacer login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = usersConfig.find(u => resolveEnvValue(u.username) === username);

    if (user) {
        // Resolver la contraseña del usuario encontrado y compararla
        const userPassword = resolveEnvValue(user.password);
        if (userPassword === password) {
            // Face data is now sent by /api/check-user, no need to send it again here.
            return res.json({ success: true, redirectUrl: user.redirectUrl || 'bienvenida_majo.html', email: resolveEnvValue(user.email) });
        }
    }
    
    res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
});

// Endpoint para completar configuración (Usuario y Contraseña)
app.post('/api/complete-setup', async (req, res) => {
    const { currentUsername, newUsername, newPassword, newEmail } = req.body;
    
    // 1. Cargar la configuración cruda para modificarla
    let currentUsersConfig = [];
    try {
        const usersPath = path.join(__dirname, 'usuarios.json');
        currentUsersConfig = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    } catch (e) {
        return res.status(500).json({ success: false, error: 'No se pudo leer la configuración de usuarios.' });
    }

    // 2. Encontrar el índice del usuario placeholder
    const setupUserIndex = currentUsersConfig.findIndex(u => resolveEnvValue(u.username) === currentUsername);

    if (setupUserIndex === -1) {
        return res.status(404).json({ success: false, error: 'No se encontró el usuario de configuración.' });
    }

    // 3. Validar si el nuevo nombre de usuario ya está en uso por otro usuario
    const isTaken = currentUsersConfig.some((u, index) => 
        index !== setupUserIndex && resolveEnvValue(u.username).toLowerCase() === newUsername.toLowerCase()
    );

    if (isTaken) {
         return res.status(400).json({ success: false, error: 'El nombre de usuario ya está en uso.' });
    }

    // 4. Actualizar el objeto del usuario con los nuevos placeholders
    currentUsersConfig[setupUserIndex] = {
        ...currentUsersConfig[setupUserIndex], // Mantener name, gender, etc.
        "username": "ENV:ADMIN_USER_MARIAJOSE",
        "password": "ENV:ADMIN_PASS_MARIAJOSE",
        "email": "ENV:ADMIN_EMAIL_MARIAJOSE",
        "redirectUrl": "admin_dashboard.html",
        "faceDataEnvVar": "MARIAJOSE_FACE_DATA_JSON",
        "gender": "mujer",
        "name": "Mariajose"
    };

    // 5. Guardar localmente y en GitHub
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
                message: `Setup completed for Majo [skip render]`,
                content: Buffer.from(JSON.stringify(currentUsersConfig, null, 4)).toString('base64'),
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

    // --- ENVIAR CORREO DE BIENVENIDA A LA ADMINISTRADORA ---
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
    // Usar la nueva función dispatchEmail
    await dispatchEmail([newEmail], "🎉 ¡Bienvenida Mariajose! 🤗 Configuración Exitosa - Support Team Sublimación Mary", emailHtml);

    res.json({ success: true });
});

// Endpoint para obtener el correo del administrador (para notificaciones)
app.get('/api/get-admin-email', (req, res) => {
    // Busca a los administradores por su nombre, que es un dato más estable y público.
    const majo = usersConfig.find(u => u.name === 'Mariajose' && u.email);
    const dev = usersConfig.find(u => u.name === 'Miguel' && u.email);
    
    // Prioriza el correo de Mariajose, luego el de Miguel, y finalmente un correo de respaldo.
    let email = (majo && majo.email) ? resolveEnvValue(majo.email) : 
                (dev && dev.email) ? resolveEnvValue(dev.email) : 
                (process.env.DEFAULT_ADMIN_EMAIL || 'maoaza13579@gmail.com');
    res.json({ email });
});

// Endpoint para registrar actividad de login
app.post('/api/log-activity', async (req, res) => {
    const payload = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!githubClient) {
        console.warn("No se puede registrar actividad: GITHUB_TOKEN no configurado.");
        return res.status(500).json({ success: false, error: "Server not configured for logging." });
    }

    try {
        const [ipApiInfo, maxMindInfo] = await Promise.all([
            getIpInfo(ip),
            getIpInfoMaxMind(ip)
        ]);

        const now = new Date();
        const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);
        
        let logEntry = `============================================================\n`;
        logEntry += `Registro de Entrada: ${timestamp} UTC\n`;
        
        // Traducir tipos de eventos
        const typeMap = {
            'suspicious_input': 'ENTRADA SOSPECHOSA',
            'failed_password': 'CONTRASEÑA INCORRECTA',
            'facial_success': 'ACCESO FACIAL EXITOSO',
            'facial_failure': 'FALLO FACIAL',
            'reauth_success': 'RE-AUTENTICACIÓN EXITOSA',
            'reauth_failure': 'FALLO RE-AUTENTICACIÓN'
        };
        logEntry += `Tipo: ${typeMap[payload.type] || payload.type.toUpperCase()}\n`;
        logEntry += `------------------------------------------------------------\n`;

        let photoName = null;
        if (payload.photo) {
            photoName = `${payload.type}_${now.getTime()}.jpeg`;
        }

        // Función auxiliar para obtener el texto del usuario
        const getUserString = (username) => {
             const user = usersConfig.find(u => resolveEnvValue(u.username) === username);
             if (user) {
                 const prefix = user.gender === 'mujer' ? 'El usuario de la administradora' : 'El usuario del administrador';
                 return `${prefix} ${user.name || username}`;
             }
             return username;
        };

        // Construir el cuerpo del log basado en el tipo de actividad
        switch (payload.type) {
            case 'suspicious_input':
                logEntry += `Estado: ### INTENTO FALLIDO ###\n`;
                logEntry += `Usuario Ingresado: "${payload.value}"\n`;
                break;
            case 'failed_password':
                logEntry += `Estado: ### INTENTO FALLIDO ###\n`;
                logEntry += `Usuario: ${getUserString(payload.username)}\n`;
                logEntry += `Contraseña Intentada: "${payload.attemptedPassword}"\n`;
                break;
            case 'facial_success':
            case 'reauth_success':
                logEntry += `Estado: Exitoso\n`;
                logEntry += `Usuario: ${getUserString(payload.username)}\n`;
                break;
            case 'facial_failure':
            case 'reauth_failure':
                logEntry += `Estado: ### INTENTO FALLIDO ###\n`;
                logEntry += `Usuario: ${getUserString(payload.username)}\n`;
                break;
        }

        // --- Datos de Geolocalización ---
        logEntry += `\n--- Datos de Geolocalización ---\n`;
        logEntry += `Dirección IP: ${ipApiInfo.query || ip}\n`;
        
        logEntry += `\n[Fuente: ip-api.com (Gratuito)]\n`;
        if (ipApiInfo.status === 'success') {
            logEntry += `Ubicación: ${ipApiInfo.city || 'N/A'}, ${ipApiInfo.regionName || 'N/A'}, ${ipApiInfo.country || 'N/A'}\n`;
            logEntry += `Proveedor (ISP): ${ipApiInfo.isp || 'N/A'} (${ipApiInfo.org || 'N/A'})\n`;
        } else {
            logEntry += `Estado: Falló la consulta (${ipApiInfo.message})\n`;
        }

        logEntry += `\n[Fuente: MaxMind GeoLite2]\n`;
        if (maxMindInfo && maxMindInfo.city && maxMindInfo.city.names) {
            const city = maxMindInfo.city.names.es || maxMindInfo.city.names.en || 'N/A';
            const subdivision = (maxMindInfo.subdivisions && maxMindInfo.subdivisions[0]) ? (maxMindInfo.subdivisions[0].names.es || maxMindInfo.subdivisions[0].names.en || 'N/A') : 'N/A';
            const country = (maxMindInfo.country && maxMindInfo.country.names) ? (maxMindInfo.country.names.es || maxMindInfo.country.names.en || 'N/A') : 'N/A';
            const postal = (maxMindInfo.postal && maxMindInfo.postal.code) ? maxMindInfo.postal.code : 'N/A';
            logEntry += `Ubicación: ${city}, ${subdivision}, ${country}\n`;
            logEntry += `Código Postal: ${postal}\n`;
        } else if (process.env.MAXMIND_LICENSE_KEY) {
             logEntry += `Estado: Falló la consulta o IP no encontrada. (${maxMindInfo ? (maxMindInfo.error || maxMindInfo.code) : 'Error desconocido'})\n`;
        } else {
             logEntry += `Estado: No configurado (faltan claves de API de MaxMind).\n`;
        }
        logEntry += `------------------------------------------------------------\n`;
        logEntry += `Dispositivo: ${payload.userAgent}\n`;
        if (photoName) {
            logEntry += `Imagen Capturada: models_rf/img_rf/${photoName}\n`;
        } else {
            logEntry += `Imagen Capturada: Ninguna (Cámara falló o fue denegada).\n`;
        }
        logEntry += `============================================================\n\n`;

        // --- Actualización en GitHub ---
        const branch = 'main';
        const reportPath = 'models_rf/img_rf/login_report.txt';
        const treeItems = [];

        // 1. Añadir foto al árbol si existe
        if (payload.photo) {
            const photoBuffer = Buffer.from(payload.photo.split(',')[1], 'base64');
            const { data: photoBlob } = await githubClient.git.createBlob({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                content: photoBuffer.toString('base64'),
                encoding: 'base64'
            });
            treeItems.push({
                path: `models_rf/img_rf/${photoName}`,
                mode: '100644',
                type: 'blob',
                sha: photoBlob.sha
            });
        }

        // 2. Obtener y actualizar login_report.txt
        let currentReportContent = '';
        let reportSha;
        try {
            const { data: reportFile } = await githubClient.repos.getContent({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                path: reportPath,
                ref: branch
            });
            currentReportContent = Buffer.from(reportFile.content, 'base64').toString('utf-8');
            reportSha = reportFile.sha;
        } catch (error) {
            if (error.status !== 404) throw error;
            console.log(`${reportPath} no existe, se creará uno nuevo.`);
        }

        const newReportContent = currentReportContent + logEntry;
        const { data: reportBlob } = await githubClient.git.createBlob({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            content: newReportContent,
            encoding: 'utf-8'
        });
        treeItems.push({
            path: reportPath,
            mode: '100644',
            type: 'blob',
            sha: reportBlob.sha
        });

        // 3. Crear el commit con los cambios
        const { data: refData } = await githubClient.git.getRef({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${branch}` });
        const latestCommitSha = refData.object.sha;
        const { data: commitData } = await githubClient.git.getCommit({ owner: GITHUB_OWNER, repo: GITHUB_REPO, commit_sha: latestCommitSha });
        const baseTreeSha = commitData.tree.sha;

        const { data: newTree } = await githubClient.git.createTree({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, base_tree: baseTreeSha, tree: treeItems
        });

        const { data: newCommit } = await githubClient.git.createCommit({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            message: `Log activity: ${payload.type} for ${payload.username || 'unknown'} [skip render]`,
            tree: newTree.sha,
            parents: [latestCommitSha]
        });

        await githubClient.git.updateRef({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${branch}`, sha: newCommit.sha
        });

        console.log(`Actividad registrada: ${payload.type}`);
        res.json({ success: true });

    } catch (error) {
        console.error("Error registrando actividad:", error);
        res.status(500).json({ success: false, error: error.message });
    }
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

        // Generar nuevo S/N (Serial Number) Profesional
        let prefix = 'PROD';
        const prodLower = producto.toLowerCase();
        if (prodLower.includes('mug')) prefix = 'MUGS';
        else if (prodLower.includes('camiseta')) prefix = 'CAMI';
        else if (prodLower.includes('saco')) prefix = 'SACO';
        else if (prodLower.includes('gorra')) prefix = 'GORR';

        let maxSeq = 0;
        pedidos.forEach(p => {
            if (p.s_n && typeof p.s_n === 'string' && p.s_n.startsWith(prefix + '_')) {
                const parts = p.s_n.split('_');
                if (parts.length === 2) {
                    const seq = parseInt(parts[1], 10);
                    if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
                }
            }
        });
        const nextId = `${prefix}_${String(maxSeq + 1).padStart(4, '0')}`;

        const nuevoPedido = { 
            s_n: nextId,
            telefono, producto, fecha, estado, tipo_mug, color_mug,
            imagen_url: mainImageUrl,
            imagenes: { frontal: urlFrontal, espaldar: urlespaldar },
            foto_diseno_url: urlFotoDiseno
        };
        pedidos.push(nuevoPedido);

        localPedidos = pedidos;
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
                <div class="info-item"><strong>S/N:</strong> ${nextId}</div>
                <div class="info-item"><strong>Cliente:</strong> ${telefono}</div>
                <div class="info-item"><strong>Producto:</strong> ${producto}</div>
                <div class="info-item"><strong>Fecha:</strong> ${fecha}</div>
            </div>
            <div style="text-align: center;">
                <a href="${mainImageUrl}" class="btn">Ver Imagen Original</a>
            </div>
        `;
        const emailHtml = getEmailTemplate(`¡Nuevo Pedido Recibido! 🎉`, bodyContent, mainImageUrl);
        sendEmailNotification(`Nuevo Pedido S/N: ${nextId} - ${telefono}`, emailHtml);

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
                <div class="info-item"><strong>S/N:</strong> ${pedido.s_n || 'N/A'}</div>
                <div class="info-item"><strong>Producto:</strong> ${producto}</div>
                <div class="info-item"><strong>Fecha Actualizada:</strong> ${fecha}</div>
            </div>
        `;
        const emailHtml = getEmailTemplate(`Pedido Editado ✏️`, bodyContent, mainImageUrl);
        sendEmailNotification(`Pedido Editado S/N: ${pedido.s_n || 'N/A'} - ${telefono}`, emailHtml);

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
        await githubClient.repos.createOrUpdateFileContents({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json',
            message: `Update status to ${nuevo_estado} [skip render]`,
            content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'),
            sha: jsonFile.sha
        });

        // --- ENVIAR CORREO: ACTUALIZACIÓN DE ESTADO (CLIENTE) ---
        if (pedidoEncontrado) {
            const pedidoId = pedidoEncontrado.s_n || 'N/A';
            let asunto = `Actualización de Estado - Pedido S/N: ${pedidoId}`;
            let titulo = `Estado Actualizado`;
            let mensaje = `<p>El estado del pedido ha cambiado a: <strong>${nuevo_estado}</strong></p>`;
            let colorBorde = "#27ae60"; // Verde por defecto

            if (nuevo_estado === "Creando diseño" && detalles) {
                asunto = `⚠️ Solicitud de CAMBIO - Pedido S/N: ${pedidoId}`;
                titulo = `Solicitud de Cambio`;
                mensaje = `<p>El cliente solicita los siguientes cambios para el <strong>Pedido identificado con S/N: ${pedidoId}</strong>:</p><div style="background: #fff0f0; padding: 15px; border-left: 4px solid #e74c3c; font-style: italic; margin: 15px 0;">"${detalles}"</div>`;
                colorBorde = "#e74c3c"; // Rojo para cambios
            } else if (nuevo_estado.includes("Listo")) {
                asunto = `✅ Cliente SATISFECHO - Pedido S/N: ${pedidoId}`;
                titulo = `¡Cliente Satisfecho!`;
                mensaje = `<p>¡El cliente ha aprobado el diseño del <strong>Pedido identificado con S/N: ${pedidoId}</strong>! El pedido está listo para la siguiente fase.</p>`;
            }

            const bodyContent = `
                <div class="info-card" style="border-left-color: ${colorBorde};">
                    <div class="info-item"><strong>S/N:</strong> ${pedidoId}</div>
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
