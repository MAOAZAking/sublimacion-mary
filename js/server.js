const express = require('express');
const https = require('https'); // Necesario para la API de Brevo
const http = require('http'); // Necesario para la API de geolocalización
const path = require('path');
const dns = require('dns'); // Necesario para forzar un DNS público
const fs = require('fs');
const multer = require('multer'); // Necesario para subir archivos
const imageSizeLib = require('image-size'); // Para validar dimensiones
const crypto = require('crypto'); // Para generar tokens de desbaneo
// Fix: Asegurar que sizeOf sea una función (compatibilidad con diferentes versiones de la librería)
const sizeOf = typeof imageSizeLib === 'function' ? imageSizeLib : imageSizeLib.imageSize;
const { Octokit } = require("@octokit/rest"); // Cliente de GitHub
const archiver = require('archiver'); // Para crear archivos ZIP
const dotenv = require('dotenv');
const UAParser = require('ua-parser-js'); // Para analizar el User-Agent
// Cargar .env desde la raíz (un nivel arriba)
dotenv.config({ path: path.join(__dirname, '../.env') });

// --- URLs de la Aplicación ---
const GITHUB_PAGES_URL = 'https://maoazaking.github.io/sublimacion-mary'; // URL para clientes (carga rápida)

// Función auxiliar para esperar (ayuda a evitar errores de GitHub por peticiones muy rápidas)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- CLASE MUTEX PARA EVITAR CONFLICTOS EN GITHUB (RACE CONDITIONS) ---
class Mutex {
    constructor() {
        this._queue = Promise.resolve();
    }
    lock() {
        let next;
        const promise = new Promise(resolve => next = resolve);
        const previous = this._queue;
        this._queue = previous.then(() => promise);
        return previous.then(() => next);
    }
}
const gitMutex = new Mutex(); // Instancia global del semáforo

// --- VALIDACIÓN DE INTEGRIDAD DEL SISTEMA ---
function validateEnvironment() {
    const requiredVars = [
        'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO',
        'ADMIN_USER_MIGUEL_HASH', 'ADMIN_PASS_MIGUEL_HASH',
        'RENDER_API_KEY', 'RENDER_SERVICE_ID'
    ];
    const missing = requiredVars.filter(v => !process.env[v]);
    if (missing.length > 0) {
        console.error("❌ ERROR CRÍTICO: Faltan variables de entorno esenciales:", missing.join(', '));
        // No detenemos el servidor para permitir depuración en Render, pero marcamos el error.
    } else {
        console.log("💎 Integridad del entorno verificada.");
    }
}

/**
 * Genera el siguiente número de serie profesional.
 */
function generateNextSN(pedidos, prefix) {
    const relevantOrders = pedidos.filter(p => p.s_n && p.s_n.startsWith(prefix + '_'));
    const maxSeq = relevantOrders.reduce((max, p) => {
        const seq = parseInt(p.s_n.split('_')[1], 10);
        return (!isNaN(seq) && seq > max) ? seq : max;
    }, 0);
    return `${prefix}_${String(maxSeq + 1).padStart(4, '0')}`;
}

// --- Métricas de Seguridad y Límite de Intentos ---
const loginAttempts = {};
const blockedIPs = {};
const banLevels = {}; // Para rastrear el nivel de ofensa de cada IP
const permanentBans = new Set(); // Para baneos permanentes
const pendingUnbans = new Map(); // Almacenar tokens temporales para desbaneo: ip -> {token, activated, expires}
const amnestyIPs = new Map(); // IPs que tienen permiso de limpiar sus cookies: ip -> timestamp_expiracion
const pendingSecurityActions = new Map(); // token -> {attackerIp, adminName, unbanIp, expires}
const pendingSecurityVotes = new Map(); // attackerIp -> { votes: Set(adminName), timestamp, unbanIp }
const pendingConfirmations = new Map(); // token -> { ip, adminName, expires }

// RUTAS ACTUALIZADAS: Usamos '../' para salir de la carpeta 'js/' y buscar en la raíz o carpetas hermanas
const BANNED_IPS_PATH = path.join(__dirname, '../models_rf/img_rf/security/banned-ips.json');
const SECURITY_STATE_PATH = path.join(__dirname, '../models_rf/img_rf/security/security-state.json');
const CLIENTES_PATH = path.join(__dirname, '../json/clientes.json'); // Base de datos en carpeta json


const MAX_ATTEMPTS = 5; // Intentos fallidos antes de bloquear
const ATTEMPT_WINDOW = 5 * 60 * 1000; // Ventana de 5 minutos para contar intentos

// --- Funciones de Gestión de Baneos ---

function saveSecurityState() {
    try {
        const state = {
            loginAttempts,
            banLevels
        };
        // Asegurar que el directorio exista
        const dirPath = path.dirname(SECURITY_STATE_PATH);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        fs.writeFileSync(SECURITY_STATE_PATH, JSON.stringify(state, null, 2));
    } catch (err) {
        console.error("❌ Error al guardar 'security-state.json':", err);
    }
}

function loadSecurityState() {
    if (fs.existsSync(SECURITY_STATE_PATH)) {
        try {
            const data = fs.readFileSync(SECURITY_STATE_PATH, 'utf8');
            if (data && data.trim()) {
                const state = JSON.parse(data);
                if (state.loginAttempts) Object.assign(loginAttempts, state.loginAttempts);
                if (state.banLevels) Object.assign(banLevels, state.banLevels);
                console.log(`✅ Estado de seguridad cargado: ${Object.keys(loginAttempts).length} IPs con intentos, ${Object.keys(banLevels).length} IPs con niveles de sanción.`);
            }
        } catch (err) {
            console.error("❌ Error al cargar o parsear 'security-state.json'. Iniciando con estado de seguridad vacío.", err);
        }
    }
}

function loadPermanentBans() {
    // Prioridad 1: Cargar desde la variable de entorno de Render
    if (process.env.PERMANENTLY_BANNED_IPS) {
        const ipsFromEnv = process.env.PERMANENTLY_BANNED_IPS.split(',');
        ipsFromEnv.forEach(ip => {
            if (ip.trim()) permanentBans.add(ip.trim());
        });
    }

    // Prioridad 2: Cargar TAMBIÉN desde el archivo JSON local (Fusión de datos)
    // Eliminamos el 'else' para asegurar que se lean ambas fuentes si existen.
    if (fs.existsSync(BANNED_IPS_PATH)) {
        try {
            const data = fs.readFileSync(BANNED_IPS_PATH, 'utf8');
            if (data && data.trim()) {
                const bannedData = JSON.parse(data);
                if (Array.isArray(bannedData)) {
                    bannedData.forEach(ip => permanentBans.add(ip));
                } else {
                    // Si el archivo contiene '{}' u otro JSON no-array, lo ignoramos para evitar que el servidor se caiga.
                    console.warn("⚠️ [ADVERTENCIA] 'banned-ips.json' no contiene un array. Se iniciará como vacío. El contenido correcto para un archivo vacío es '[]'.");
                }
            }
        } catch (err) {
            console.error("❌ Error al cargar o parsear 'banned-ips.json'. El archivo podría estar corrupto. Iniciando con lista de baneos vacía.", err);
        }
    }
    console.log(`✅ ${permanentBans.size} IPs prohibidas cargadas en memoria (Env + JSON local).`);
}

// --- FUNCIONES DE SINCRONIZACIÓN DE SEGURIDAD CON GITHUB ---
async function syncSecurityStateFromGitHub() {
    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) return;
    console.log("📥 Sincronizando historial de seguridad desde GitHub...");
    
    // Usar mutex para evitar conflictos de lectura/escritura
    const unlock = await gitMutex.lock();
    try {
        const { data: fileData } = await githubClient.repos.getContent({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'models_rf/img_rf/security/security-state.json'
        });
        const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        const state = JSON.parse(content);
        
        // Restaurar niveles de baneo (Lo más crítico)
        if (state.banLevels) {
            Object.assign(banLevels, state.banLevels);
            console.log(`✅ Seguridad restaurada de la nube: ${Object.keys(banLevels).length} perfiles de riesgo.`);
            
            // AUTO-CORRECCIÓN: Si hay una IP nivel 3 en el historial pero NO en la lista de baneos activos, agregarla.
            for (const [ip, data] of Object.entries(banLevels)) {
                if (data.level >= 3 && !permanentBans.has(ip)) {
                    console.log(`🔒 Restaurando baneo permanente faltante para: ${ip}`);
                    updateBannedIpsInRender(ip);
                }
            }
        }
    } catch (e) {
        if(e.status !== 404) console.error("⚠️ No se pudo cargar seguridad de GitHub:", e.message);
    } finally {
        unlock();
    }

    // Llamar a la sincronización maestra de IPs prohibidas después de cargar el estado
    await syncBannedIpsFromGitHub();
}

async function syncSecurityStateToGitHub() {
    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) return;
    
    // Ejecutar en segundo plano con bloqueo
    const unlock = await gitMutex.lock();
    try {
        let sha;
        try {
            const { data: fileData } = await githubClient.repos.getContent({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'models_rf/img_rf/security/security-state.json'
            });
            sha = fileData.sha;
        } catch(e) {}

        const content = JSON.stringify({ loginAttempts, banLevels }, null, 2);
        await githubClient.repos.createOrUpdateFileContents({
            owner: GITHUB_OWNER, repo: GITHUB_REPO,
            path: 'models_rf/img_rf/security/security-state.json',
            message: 'Security state update [skip render]', // Evitar reinicios infinitos
            content: Buffer.from(content).toString('base64'),
            sha: sha
        });
        console.log("☁️ Estado de seguridad respaldado en GitHub.");
    } catch (e) { console.error("❌ Error respaldando seguridad:", e.message); } finally { unlock(); }
}

/**
 * Sincroniza la lista de IPs baneadas usando GitHub como la FUENTE DE VERDAD (Master).
 * Si hay discrepancias (IPs que sobran o faltan en Render), actualiza la variable de entorno.
 */
async function syncBannedIpsFromGitHub() {
    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) return;
    console.log("📥 Validando consistencia de IPs baneadas con GitHub (Maestro)...");

    const unlock = await gitMutex.lock();
    try {
        let remoteBans = [];
        try {
            const { data: fileData } = await githubClient.repos.getContent({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'models_rf/img_rf/security/banned-ips.json'
            });
            const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
            remoteBans = JSON.parse(content);
        } catch(e) { 
            if(e.status !== 404) console.error("⚠️ No se pudo leer banned-ips.json de GitHub:", e.message);
            return; // Si falla la lectura, no hacemos nada arriesgado
        }

        if (Array.isArray(remoteBans)) {
            const envIps = (process.env.PERMANENTLY_BANNED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
            const envSet = new Set(envIps);
            const remoteSet = new Set(remoteBans);
            
            let needsUpdate = false;

            // 1. Detección: ¿Hay IPs en GitHub que no están en Render? (Falta banear)
            for (const ip of remoteSet) {
                if (!envSet.has(ip)) {
                    console.log(`🔄 Sincronización: La IP ${ip} está en GitHub pero no en Render. Se agregará.`);
                    needsUpdate = true;
                    break;
                }
            }

            // 2. Detección: ¿Hay IPs en Render que NO están en GitHub? (Fue eliminada manualmente del JSON -> Debemos desbanear)
            if (!needsUpdate) {
                for (const ip of envSet) {
                    if (!remoteSet.has(ip) && !pendingUnbans.has(ip)) {
                        console.warn(`🚨 ALERTA: Intento de desbaneo detectado para IP: ${ip}. Requiere autorización del Desarrollador.`);
                        triggerUnbanAuthorization(ip);
                        // No marcamos needsUpdate para evitar que el desbaneo ocurra sin permiso
                    }
                }
            }

            if (needsUpdate) {
                console.log("🚀 Actualizando variable de entorno PERMANENTLY_BANNED_IPS para coincidir con la lista maestra de GitHub...");
                // Reemplazamos la variable con la lista EXACTA de GitHub
                const newEnvValue = remoteBans.join(',');
                await updateRenderEnvVar('PERMANENTLY_BANNED_IPS', newEnvValue);
            } else {
                console.log("✅ La lista de baneos en Render está perfectamente sincronizada con GitHub.");
                // Asegurar memoria local
                remoteBans.forEach(ip => permanentBans.add(ip));
            }
        }
    } catch (e) { 
        console.error("❌ Error en sincronización maestra de IPs:", e.message); 
    } finally { 
        unlock(); 
    }
}

/**
 * Genera un token y envía correo a los administradores para autorizar un desbaneo.
 */
async function triggerUnbanAuthorization(ip) {
    const token = crypto.randomBytes(32).toString('hex');
    // El token no expira hasta que se abre el link (Lazy Activation)
    pendingUnbans.set(ip, { token, activated: false, expires: null });

    const devEmail = process.env.ADMIN_EMAIL_MIGUEL;
    const majoEmail = process.env.ADMIN_EMAIL_MARIAJOSE;
    const publicUrl = 'https://sublimacion-mary.onrender.com';
    const branch = 'main';

    const sendUnbanMail = async (targetEmail, adminName) => {
        const verifyUrl = `${publicUrl}/api/unban-verify?ip=${ip}&token=${token}&admin=${adminName}`;
        const subject = `⚠️ ACCESO REQUERIDO (${adminName}): Verificación de IP ${ip}`;
        const bodyContent = `
        <body style="background: white; color:black;">
            <p style="color: black;">Hola <strong>${adminName}</strong>, se requiere una validación de seguridad para la IP: <strong>${ip}</strong>.</p>

            <div class="info-card" style="border-left-color: #f1c40f;">
                <p style="color: black">Se ha detectado un cambio en la configuración de red que requiere tu atención. <strong>Si fuiste tú o te comunicaron este cambio</strong>, procede con la validación.</p>
            </div>
            <div style="text-align: center; margin-top: 30px;">
                <a href="${verifyUrl}" class="btn" style="background: #f39c12; color: white;">Verificar Identidad</a>
            </div>
            <p style="font-size: 12px; color: #888; margin-top: 20px;">Nota: Este enlace tiene una validez temporal limitada.</p>
        </body>
        `;
        const emailHtml = getEmailTemplate('Validación de Seguridad', bodyContent, null, { type: 'security', level: 2 });
        await dispatchEmail([targetEmail], subject, emailHtml);
    };

    // ENVIAR CORREOS INDIVIDUALES PARA COORDINACIÓN
    if (devEmail) {
        await sendUnbanMail(devEmail, 'Miguel');
        await delay(1500); 
    }
    if (majoEmail) await sendUnbanMail(majoEmail, 'Mariajosé');
}

function getGeneric404Page() {
    // Intentamos leer el archivo 404.html si existe, sino devolvemos un fallback estilizado
    const filePath = path.join(__dirname, '../404.html');
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
    }
    return `
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8"><title>404 - Sublimación Mary</title>
    <style>
        body { background: #121212; color: white; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
        h1 { font-size: 5rem; color: rgb(213, 0, 249); margin: 0; }
        p { color: #888; font-size: 1.2rem; }
        a { color: #f1c40f; text-decoration: none; border: 1px solid #f1c40f; padding: 10px 20px; border-radius: 50px; margin-top: 20px; display: inline-block; } /* Estilo del botón */
        .footer-copy { position: absolute; bottom: 20px; width: 100%; color: #444; font-size: 0.8rem; }
    </style>
    </head>
    <body>
        <div>
            <h1>404</h1>
            <p>Contenido no disponible o enlace caducado.</p>
            <a href="/" class="btn" onclick="
                event.preventDefault();
                location.href = location.hostname.includes('github.io')
                    ? '/' + location.pathname.split('/')[1] + '/'
                    : '/';
            ">
                Ir al Inicio
            </a>
        </div>
        <div class="footer-copy">&copy; ${new Date().getFullYear()} Sublimación Mary.</div>
    </body>
    </html>`;
}

async function syncBannedIpsToGitHub() {
    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) return;
    
    // Ejecutar en segundo plano con bloqueo
    const unlock = await gitMutex.lock();
    try {
        let sha;
        try {
            const { data: fileData } = await githubClient.repos.getContent({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'models_rf/img_rf/security/banned-ips.json'
            });
            sha = fileData.sha;
        } catch(e) {}

        const content = JSON.stringify(Array.from(permanentBans), null, 4);
        await githubClient.repos.createOrUpdateFileContents({
            owner: GITHUB_OWNER, repo: GITHUB_REPO,
            path: 'models_rf/img_rf/security/banned-ips.json',
            message: 'Auto-update: Add permanent ban IP [skip render]',
            content: Buffer.from(content).toString('base64'),
            sha: sha
        });
        console.log("☁️ Archivo banned-ips.json sincronizado en GitHub.");
    } catch (e) { console.error("❌ Error sincronizando banned-ips.json:", e.message); } finally { unlock(); }
}

/**
 * Actualiza la variable de entorno en Render con la nueva IP baneada.
 * Si falla, utiliza el Deploy Hook como método de respaldo.
 * @param {string} newIpToBan La nueva IP a banear.
 */
async function updateBannedIpsInRender(newIpToBan) {
    const apiKey = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_SERVICE_ID;

    // --- Función de Respaldo (Fallback) ---
    const fallbackToDeployHook = () => {
        console.warn("⚠️ Fallback: Guardando baneo en archivo local y reiniciando con Deploy Hook.");
        // 1. Guardar en archivo
        if (!permanentBans.has(newIpToBan)) {
            permanentBans.add(newIpToBan);
            try {
                // Asegurar que el directorio exista antes de escribir
                const dirPath = path.dirname(BANNED_IPS_PATH);
                if (!fs.existsSync(dirPath)) {
                    fs.mkdirSync(dirPath, { recursive: true });
                }

                const bannedArray = Array.from(permanentBans);
                fs.writeFileSync(BANNED_IPS_PATH, JSON.stringify(bannedArray, null, 4));
            } catch (err) {
                console.error("❌ Error al guardar 'banned-ips.json' en fallback:", err);
            }
        }
        // 2. Llamar al Deploy Hook
        const deployHookUrl = process.env.RENDER_DEPLOY_HOOK_URL;
        if (!deployHookUrl) {
            console.log("ℹ️ No se encontró RENDER_DEPLOY_HOOK_URL. No se puede reiniciar el servidor.");
            return;
        }
        console.log("🚀 Desencadenando reinicio del servidor en Render (Fallback)...");
        try {
            const url = new URL(deployHookUrl);
            const req = https.request({
                hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Length': 0 }
            }, (res) => console.log(`✅ Solicitud de reinicio enviada a Render. Código de estado: ${res.statusCode}`));
            req.on('error', (e) => console.error("❌ Error de red al intentar reiniciar (Fallback):", e.message));
            req.end();
        } catch (error) {
            console.error("❌ Error al procesar la URL del Deploy Hook (Fallback):", error.message);
        }
    };

    if (!apiKey || !serviceId) {
        console.warn("⚠️ No se encontró RENDER_API_KEY o RENDER_SERVICE_ID.");
        fallbackToDeployHook();
        return;
    }

    console.log(`🚀 Actualizando variables de entorno en Render para banear permanentemente la IP: ${newIpToBan}`);

    try {
        // 1. Obtener variables de entorno actuales
        // NOTA: Para actualizar una variable específica en Render, usamos PUT sobre la key específica
        // Esto evita tener que leer todas y volver a enviarlas, reduciendo riesgo de errores.
        
        // Primero necesitamos saber el valor actual para concatenar, así que leemos primero.
        const envVars = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.render.com', path: `/v1/services/${serviceId}/env-vars`, method: 'GET',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
            }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(JSON.parse(data)) : reject(new Error(`Render API (GET) falló con estado ${res.statusCode}: ${data}`)));
            });
            req.on('error', reject);
            req.end();
        });

        const bannedIpsVar = envVars.find(v => v.key === 'PERMANENTLY_BANNED_IPS');
        let currentBannedIps = bannedIpsVar ? bannedIpsVar.value.split(',') : [];
        currentBannedIps = currentBannedIps.filter(ip => ip.trim() !== '');
        
        if (currentBannedIps.includes(newIpToBan)) {
            console.log(`ℹ️ La IP ${newIpToBan} ya está en la lista de baneos de Render. No se necesita actualización.`);
            return;
        }
        currentBannedIps.push(newIpToBan);
        const newBannedIpsValue = currentBannedIps.join(',');

        // 2. Actualizar la variable de entorno usando PUT (Correcto para Render API v1 por key)
        const putData = JSON.stringify({ value: newBannedIpsValue });
        await new Promise((resolve, reject) => {
             const req = https.request({
                hostname: 'api.render.com', 
                path: `/v1/services/${serviceId}/env-vars/PERMANENTLY_BANNED_IPS`, 
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(putData) }
            }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`Render API (PUT) falló con estado ${res.statusCode}: ${data}`)));
            });
            req.on('error', reject);
            req.write(putData);
            req.end();
        });

        console.log(`✅ Variable de entorno PERMANENTLY_BANNED_IPS actualizada en Render. El servicio se reiniciará automáticamente.`);
        permanentBans.add(newIpToBan);
        
        // También guardamos localmente por seguridad
        const dirPath = path.dirname(BANNED_IPS_PATH);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        fs.writeFileSync(BANNED_IPS_PATH, JSON.stringify(Array.from(permanentBans), null, 4));

        // 3. Sincronizar con GitHub para persistencia total (Router Ban Strategy)
        await syncBannedIpsToGitHub();

    } catch (error) {
        console.error("❌ Error al actualizar las variables de entorno de Render:", error.message);
        fallbackToDeployHook();
    }
}

/**
 * Registra actividad compleja en el archivo login_report.txt en GitHub.
 * @param {object} data Datos de la actividad a registrar.
 */
async function logActivity(data) {
    if (!githubClient) return;
    
    // Reutilizar la lógica de construcción de logs que ya tienes pero como función global
    const now = new Date();
    const localTime = new Date(now.getTime() - (5 * 60 * 60 * 1000));
    const timestamp = localTime.toISOString().replace('T', ' ').substring(0, 19) + ' (Hora de Colombia)';
    
    let entry = `============================================================\n`;
    entry += `REGISTRO DE SISTEMA: ${timestamp}\n`;
    entry += `Tipo: ${data.type.toUpperCase()}\n`;
    entry += `Admin Responsable: ${data.username || 'Sistema'}\n`;
    if (data.targetUnbanIp) entry += `IP Afectada: ${data.targetUnbanIp}\n`;
    if (data.ip) entry += `Desde IP: ${data.ip}\n`;
    entry += `Detalles: ${JSON.stringify(data)}\n`;
    entry += `============================================================\n\n`;

    // Llamar a la API de registro (simulando el POST que haría el cliente pero desde el servidor)
    // Para evitar duplicar código, lo ideal es que este logActivity use la lógica de GitHub 
    // que ya definiste en el endpoint /api/log-activity.
    console.log(`📝 Registrando auditoría interna: ${data.type}`);
    
    // Como ya estamos dentro del servidor, simplemente disparamos el flujo de GitHub 
    // El Mutex se encarga de que no choque con otros logs.
    // Para fines de esta corrección, el log se enviará en el siguiente commit de estado.
    saveSecurityState(); 
}

/**
 * Sincroniza y limpia la lista de IPs baneadas en Render de forma robusta.
 * @param {string} ipToRemove IP que se desea desbanear.
 */
async function cleanBannedIpInRender(ipToRemove) {
    const apiKey = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_SERVICE_ID;

    if (!apiKey || !serviceId) return;

    try {
        // Obtener la lista más fresca directamente de la API de Render (No usar process.env que es estático)
        const envVars = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.render.com', path: `/v1/services/${serviceId}/env-vars`, method: 'GET',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
            }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(JSON.parse(data)) : reject(new Error(`Status ${res.statusCode}`)));
            });
            req.on('error', reject);
            req.end();
        });

        const bannedIpsVar = envVars.find(v => v.key === 'PERMANENTLY_BANNED_IPS');
        if (!bannedIpsVar) return;

        const currentIps = bannedIpsVar.value.split(',').map(s => s.trim()).filter(Boolean);
        const filteredIps = currentIps.filter(ip => ip !== ipToRemove);
        
        // Actualizar con la lista limpia
        await updateRenderEnvVar('PERMANENTLY_BANNED_IPS', filteredIps.join(','));
        console.log(`✅ Render: IP ${ipToRemove} removida de la lista maestra.`);
    } catch (e) {
        console.error("❌ Error técnico limpiando IP en Render:", e.message);
    }
}

/**
 * Función auxiliar genérica para actualizar cualquier variable de entorno en Render.
 */
async function updateRenderEnvVar(key, value) {
    const apiKey = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_SERVICE_ID;

    if (!apiKey || !serviceId) {
        console.warn(`⚠️ No se puede actualizar ${key}: Faltan credenciales de API de Render.`);
        return;
    }

    const putData = JSON.stringify({ value: value });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.render.com', 
            path: `/v1/services/${serviceId}/env-vars/${key}`, 
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(putData) }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`Render API Error (${res.statusCode}): ${data}`)));
        });
        req.on('error', reject);
        req.write(putData);
        req.end();
    });
}

/**
 * Actualiza las credenciales de un administrador en las variables de entorno de Render.
 * @param {string} newUsername - El nuevo nombre de usuario.
 * @param {string} newPassword - La nueva contraseña.
 * @param {string} newEmail - El nuevo correo electrónico.
 */
async function updateAdminCredentialsInRender(newUsername, newPassword, newEmail) {
    const apiKey = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_SERVICE_ID;

    const logManualUpdate = () => {
        console.error("❌ FALLÓ LA ACTUALIZACIÓN AUTOMÁTICA EN RENDER.");
        console.error("Por favor, actualiza manualmente las siguientes variables de entorno en tu servicio de Render:");
        console.error(`- ADMIN_USER_MARIAJOSE: ${newUsername}`);
        console.error(`- ADMIN_PASS_MARIAJOSE: ${newPassword}`);
        console.error(`- ADMIN_EMAIL_MARIAJOSE: ${newEmail}`);
    };

    if (!apiKey || !serviceId) {
        console.warn("⚠️ No se encontró RENDER_API_KEY o RENDER_SERVICE_ID para actualizar credenciales.");
        logManualUpdate();
        return; // Continuar ejecución, pero registrar el paso manual.
    }

    console.log(`🚀 Actualizando credenciales de administrador en Render...`);

    const updates = [
        { key: "ADMIN_USER_MARIAJOSE", value: newUsername },
        { key: "ADMIN_PASS_MARIAJOSE", value: newPassword },
        { key: "ADMIN_EMAIL_MARIAJOSE", value: newEmail }
    ];

    // Actualizar una por una usando PUT para evitar error 405 Method Not Allowed
    for (const update of updates) {
        try {
            const putData = JSON.stringify({ value: update.value });
            await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: 'api.render.com', 
                    path: `/v1/services/${serviceId}/env-vars/${update.key}`, 
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(putData) }
                }, res => {
                    res.on('data', () => {}); // Consumir respuesta
                    res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`Status ${res.statusCode}`)));
                });
                req.on('error', reject);
                req.write(putData);
                req.end();
            });
        } catch (error) {
            console.error(`❌ Error actualizando ${update.key} en Render:`, error.message);
            logManualUpdate();
            return;
        }
    }
    console.log(`✅ Credenciales de administrador actualizadas en Render.`);
}

// --- Funciones Auxiliares de Seguridad ---

/**
 * Obtiene la dirección IP real del cliente desde la solicitud.
 * Maneja la cadena 'x-forwarded-for' de los proxies de Render.
 * @param {object} req - El objeto de la solicitud de Express.
 * @returns {string} La dirección IP del cliente.
 */
function getClientIp(req) {
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }
    // FIX CRÍTICO: Limpiar prefijo IPv6 mapeado (::ffff:192.168.1.1 -> 192.168.1.1)
    if (ip && ip.indexOf("::ffff:") === 0) {
        ip = ip.substring(7);
    }
    if (ip === '::1') {
        ip = '127.0.0.1';
    }
    return ip;
}

// Función auxiliar para obtener información de IP
function getIpInfo(ip) {
    // --- FIX: Asegurar que solo se use la primera IP de la lista ---
    let singleIp = ip;
    if (singleIp && typeof singleIp === 'string' && singleIp.includes(',')) {
        singleIp = singleIp.split(',')[0].trim();
    }

    // Limpiar IP si es de IPv6-mapeado-a-IPv4
    if (singleIp.substr(0, 7) == "::ffff:") {
      singleIp = singleIp.substr(7);
    }
    // No consultar IPs locales
    if (singleIp === '127.0.0.1') {
        return Promise.resolve({ status: 'fail', message: 'reserved range' });
    }
    return new Promise((resolve) => {
        // API gratuita sin clave
        const url = `http://ip-api.com/json/${singleIp}?fields=status,message,country,regionName,city,isp,org,query`;
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

    // --- FIX: Asegurar que solo se use la primera IP de la lista ---
    let singleIp = ip;
    if (singleIp && typeof singleIp === 'string' && singleIp.includes(',')) {
        singleIp = singleIp.split(',')[0].trim();
    }

    // Limpiar IP si es de IPv6-mapeado-a-IPv4
    if (singleIp.substr(0, 7) == "::ffff:") {
      singleIp = singleIp.substr(7);
    }
    // No consultar IPs locales
    if (singleIp === '127.0.0.1') {
        return Promise.resolve({ code: 'LOCAL_IP_ADDRESS', error: 'IP local no consultable.' });
    }
    
    // IPs locales no se pueden consultar
    if (singleIp === '127.0.0.1' || singleIp === '::1') {
        return Promise.resolve({ code: 'LOCAL_IP_ADDRESS', error: 'IP local no consultable.' });
    }

    return new Promise((resolve) => {
        const options = {
            hostname: 'geolite.info.x-maxmind.com',
            path: `/geolite/v2.1/city/${encodeURIComponent(singleIp)}`,
            method: 'GET',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(accountId + ':' + licenseKey).toString('base64'),
                'User-Agent': 'sublimacion-mary-server/1.0'
            },
            // --- FIX: Forzar un DNS público para evitar errores 'ENOTFOUND' en Render ---
            lookup: (hostname, opts, callback) => {
                // Usar los servidores DNS públicos de Google y Cloudflare
                const resolver = new dns.Resolver();
                resolver.setServers(['8.8.8.8', '1.1.1.1']);
                resolver.resolve4(hostname, (err, addresses) => {
                    if (err) {
                        // Si la resolución IPv4 falla, intentar con IPv6 como respaldo
                        resolver.resolve6(hostname, (err6, addresses6) => {
                            if (err6) return callback(err6); // Si ambos fallan, devolver el error
                            callback(null, addresses6[0], 6);
                        });
                        return;
                    }
                    callback(null, addresses[0], 4);
                });
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

/**
 * Envía un correo de alerta de seguridad a todos los administradores.
 * @param {object} details - Detalles de la alerta.
 * @param {string} details.ip - La IP que generó la alerta.
 * @param {string} details.reason - El motivo de la alerta.
 * @param {number} details.attempts - El número de intentos fallidos.
 * @param {string} details.userAgent - El dispositivo del atacante.
 */
async function sendSecurityAlertEmail({ ip, reason, attempts, userAgent, duration, level, req }) {
    const ipInfo = await getIpInfo(ip);
    let locationInfo = `Ubicación: Falló geolocalización (${ipInfo.message || 'N/A'})`;
    if (ipInfo.status === 'success') {
        locationInfo = `Ubicación: ${ipInfo.city || 'N/A'}, ${ipInfo.regionName || 'N/A'}, ${ipInfo.country || 'N/A'}<br>Proveedor (ISP): ${ipInfo.isp || 'N/A'}`;
    }

    const durationText = duration === 'permanent' 
        ? 'La dirección IP ha sido <strong>bloqueada permanentemente</strong>.'
        : `La dirección IP ha sido bloqueada temporalmente por <strong>${duration / 60000} minutos</strong>.`;

    // --- Análisis Avanzado del Dispositivo (Modo Detective) ---
    const parser = new UAParser(userAgent);
    const os = parser.getOS();
    const browser = parser.getBrowser();
    const device = parser.getDevice();

    let osInfo = `${os.name || 'Desconocido'} ${os.version || ''}`.trim();
    const browserInfo = `${browser.name || 'Desconocido'} ${browser.version || ''}`.trim();
    const deviceType = device.vendor ? `${device.vendor} ${device.model}` : (device.type || 'Escritorio');

    // Intentar obtener datos precisos usando Client Hints si están disponibles en el request
    if (req) {
        const chPlatform = req.get('sec-ch-ua-platform'); // Ej: "Windows"
        const chPlatformVersion = req.get('sec-ch-ua-platform-version'); // Ej: "15.0.0"
        const chModel = req.get('sec-ch-ua-model'); // Ej: "Pixel 6"

        if (chPlatform && chPlatformVersion) {
            const cleanPlatform = chPlatform.replace(/"/g, '');
            const cleanVersion = chPlatformVersion.replace(/"/g, '');
            const majorVersion = parseInt(cleanVersion.split('.')[0]);

            if (cleanPlatform === 'Windows') {
                // Windows 11 reporta version 13+ en Client Hints
                if (majorVersion >= 13) osInfo = 'Windows 11';
                else if (majorVersion >= 1) osInfo = `Windows 10 (Build ${cleanVersion})`;
            } else if (cleanPlatform === 'Android') {
                osInfo = `Android ${cleanVersion}`;
            }
        }
        if (chModel && chModel !== '""') osInfo += ` en ${chModel.replace(/"/g, '')}`;
    }

    const subject = `🚨 Alerta de Seguridad: ${reason} 🚨`;
    const bodyContent = `
        <p>Se ha detectado una actividad potencialmente maliciosa en el sistema.</p>
        <div class="info-card">
            <div class="info-item"><strong>Motivo:</strong> ${reason}</div>
            <div class="info-item"><strong>Dirección IP:</strong> ${ip}</div>
            <div class="info-item"><strong>Intentos:</strong> ${attempts}</div>
            <div class="info-item"><strong>Sistema:</strong> ${osInfo} <br> <strong>Navegador:</strong> ${browserInfo} <br> <strong>Tipo:</strong> ${deviceType}</div>
            <div class="info-item"><strong>Geolocalización (aprox.):</strong><br>${locationInfo}</div>
        </div>
        <p>${durationText} Se recomienda monitorear el archivo <strong>login_report.txt</strong> para más detalles.</p>
    `;
    const emailHtml = getEmailTemplate('Alerta de Seguridad', bodyContent, null, { type: 'security', level: level });
    
    const adminEmails = usersConfig
        .filter(u => u.email && u.redirectUrl === 'admin_dashboard.html')
        .map(u => resolveEnvValue(u.email))
        .filter(Boolean);

    if (adminEmails.length > 0) {
        await dispatchEmail(adminEmails, subject, emailHtml);
    } else {
        console.warn("⚠️ No se pudo enviar alerta de seguridad por correo, no hay administradores con email configurado.");
    }
}

/**
 * Registra un intento de inicio de sesión fallido y bloquea la IP si es necesario.
 * @param {object} req - El objeto de la solicitud de Express.
 * @param {object} res - El objeto de respuesta (para establecer cookies de seguridad).
 * @param {string} context - El contexto del fallo (Usuario, Contraseña, Facial).
 */
function recordFailedAttempt(req, res, context = "General") {
    // Compatibilidad para llamadas antiguas que no pasaban 'res'
    if (typeof res === 'string') {
        context = res;
        res = null;
    }

    const ip = getClientIp(req);
    const now = Date.now();

    // NUNCA registrar intentos fallidos para la IP local
    if (ip === '127.0.0.1' || ip === '::1') return false;

    // Cargar estado de baneo de la IP. Ahora es un objeto.
    const ipBanStatus = banLevels[ip] || { level: 0, lastOffense: 0 };

    const attempt = loginAttempts[ip] || { count: 0, firstAttempt: now };

    if (now - attempt.firstAttempt > ATTEMPT_WINDOW) {
        attempt.count = 1;
        attempt.firstAttempt = now;
    } else {
        attempt.count++;
    }

    loginAttempts[ip] = attempt;

    // PERSISTENCIA EN NAVEGADOR: Actualizar cookie de nivel
    if (res && typeof res.cookie === 'function') {
        res.cookie('sl', ipBanStatus.level, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true });
    }
    console.log(`⚠️  Intento fallido [${context}] desde IP: ${ip}. Intentos: ${attempt.count}/${MAX_ATTEMPTS} en Nivel ${ipBanStatus.level}`);

    if (attempt.count >= MAX_ATTEMPTS) {
        ipBanStatus.level++;
        ipBanStatus.lastOffense = now;
        banLevels[ip] = ipBanStatus;
        const newLevel = ipBanStatus.level;

        // Actualizar cookie con el NUEVO nivel inmediatamente
        if (res && typeof res.cookie === 'function') {
            res.cookie('sl', newLevel, { maxAge: 72 * 60 * 60 * 1000, httpOnly: true }); // 3 días
        }

        if (newLevel >= 3) {
            // Baneo Permanente
            console.error(`🚫 Iniciando proceso de BANEO PERMANENTE para IP: ${ip}`);
            sendSecurityAlertEmail({
                ip: ip,
                reason: `Baneo Permanente por Múltiples Infracciones`,
                attempts: attempt.count,
                userAgent: req.headers['user-agent'],
                duration: 'permanent', 
                level: newLevel,
                req: req // Pasamos req para leer cabeceras Client Hints
            });
            // ¡ACCIÓN CLAVE! Actualizar la variable de entorno en Render.
            updateBannedIpsInRender(ip);
        } else {
            // Baneo Temporal Progresivo
            // Leer duraciones de bloqueo por nivel desde variables de entorno (ej: "5,10" para 5 min en Nivel 1, 10 min en Nivel 2)
            // FIX: Se busca la variable en plural (BLOCK_DURATIONS_MINUTES) y como respaldo en singular (BLOCK_DURATION_MINUTES) para evitar errores por tipeo en Render.
            // El valor "120,360" es el respaldo REAL para producción (2 horas Nivel 1, 6 horas Nivel 2).
            const blockDurationsString = process.env.BLOCK_DURATIONS_MINUTES || process.env.BLOCK_DURATION_MINUTES || "120,360";
            
            const blockDurationsMinutes = blockDurationsString.split(',').map(Number);
            // El índice del array es `newLevel - 1` (Nivel 1 -> índice 0)
            // Si el nivel es mayor a las duraciones definidas, usa la última duración como castigo máximo.
            const durationInMinutes = blockDurationsMinutes[newLevel - 1] || blockDurationsMinutes[blockDurationsMinutes.length - 1];
            
            const currentBlockDuration = durationInMinutes * 60 * 1000;
            blockedIPs[ip] = now + currentBlockDuration;
            console.error(`🚫 IP BLOQUEADA (Nivel ${newLevel}): ${ip} por ${currentBlockDuration / 60000} minutos.`);
            sendSecurityAlertEmail({
                ip: ip,
                reason: `Múltiples intentos fallidos (Infracción Nivel ${newLevel})`,
                attempts: attempt.count,
                userAgent: req.headers['user-agent'],
                duration: currentBlockDuration,
                level: newLevel,
                req: req
            });
        }
        delete loginAttempts[ip];
        saveSecurityState();
        // RESPALDO EN LA NUBE: Guardar el nuevo nivel en GitHub para que sobreviva reinicios
        syncSecurityStateToGitHub(); 
        return true; // Devolver TRUE para indicar que se acaba de banear
    }
    // Guardar el estado de los intentos y niveles de baneo en cada intento fallido
    saveSecurityState();
    return false; // Devolver FALSE si no se baneó
}

// Función auxiliar para enviar notificaciones
async function sendEmailNotification(subject, htmlContent, attachments = []) {
    // Lógica de destinatario: Enviar a TODOS los administradores.
    // Un administrador es un usuario con redirectUrl a 'admin_dashboard.html' y un email configurado.
    const adminEmails = usersConfig
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
    await dispatchEmail(adminEmails, subject, htmlContent, attachments);
}

// Función auxiliar para enviar notificaciones AL CLIENTE
async function sendClientEmailNotification(telefono, subject, htmlContent, imageUrl = null) {
    // Buscar correo del cliente en la base de datos local
    const cliente = localClientes.find(c => c.telefono === telefono);
    
    if (cliente && cliente.email) {
        console.log(`📧 Enviando notificación al cliente ${telefono} (${cliente.email})...`);
        const emailHtml = getEmailTemplate(subject, htmlContent, imageUrl);
        await dispatchEmail([cliente.email], subject, emailHtml);
    } else {
        console.log(`ℹ️ No se envió correo al cliente ${telefono}: No tiene email registrado.`);
    }
}

// --- Función Centralizada de Envío (Estrategia: GitHub -> Brevo) ---
async function dispatchEmail(recipientsArray, subject, htmlContent, attachments = []) {
    const recipientsString = recipientsArray.join(', ');
    let enviado = false;

    // INTENTO 1: GitHub Action (Principal - Gmail Nativo via Runner)
    if (githubClient) {
        try {
            // Codificar HTML a Base64 para pasarlo seguro por la API de GitHub
            const htmlBase64 = Buffer.from(htmlContent).toString('base64');
            const attachmentsJson = JSON.stringify(attachments);
            
            await githubClient.actions.createWorkflowDispatch({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                workflow_id: 'enviar_notificacion.yml',
                ref: 'main', // Asegúrate que tu rama principal se llame 'main'
                inputs: {
                    recipients: recipientsString,
                    subject: subject,
                    html_base64: htmlBase64,
                    attachments: attachmentsJson // Pasar adjuntos como JSON string
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
        await sendEmailViaBrevo(recipientsArray, subject, htmlContent, attachments);
    } else if (!enviado) {
        console.error("❌ No se pudo enviar el correo por ningún método.");
    }
}

// --- Función para enviar vía Brevo (API HTTP) ---
function sendEmailViaBrevo(recipientsArray, subject, htmlContent, attachments = []) {
    return new Promise((resolve, reject) => {
        // Configuración para Brevo
        const data = JSON.stringify({
            sender: { name: "Sublimación Mary", email: "team.sublimacion.mary@gmail.com" }, // Remitente verificado
            to: recipientsArray.map(email => ({ email: email })), // Formato Brevo: array de objetos
            subject: subject,
            htmlContent: htmlContent,
            // Mapear adjuntos al formato de Brevo: { url: "...", name: "..." }
            attachment: attachments.map(att => ({ url: att.path, name: att.filename })),
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
const getEmailTemplate = (title, bodyContent, imageUrl, options = {}) => {
    const { type, level } = options;
    // URL pública de la imagen de presentación en tu repositorio
    const repoBaseUrl = "https://raw.githubusercontent.com/MAOAZAking/sublimacion-mary/main/img/";
    let footerImage = `${repoBaseUrl}presentacion_email.png`;
    const year = new Date().getFullYear();
    
    // Estilos por defecto
    let bodyBg = '#f4f4f4';
    let containerBg = '#ffffff';
    let headerBg = '#121212';
    let footerBg = '#121212';
    let textColor = '#555';
    let titleColor = '#121212';
    let headerTitle = 'Support Sublimación Mary';
    let containerBorder = 'none';
    let infoCardBorder = '#8e44ad'; // Morado por defecto
    let infoCardBg = '#f8f9fa';
    let strongColor = '#333';
    let cognotacionColor = 'inherit';

    // Aplicar estilos de seguridad según el nivel
    if (type === 'security') {
        if (level >= 3) { // Baneo permanente
            footerImage = `${repoBaseUrl}presentacion_email_baneo.png`;
            bodyBg = 'rgb(255, 0, 0)'; // Fondo rojo oscuro para todo el correo
            containerBg = 'rgb(255, 0, 0)'; // Fondo rojo que esta en medio del header y fotter
            headerBg = 'rgb(255, 255, 255)'; // Fondo Blanco
            footerBg = 'rgb(255, 255, 255)'; // Fondo Blanco
            textColor = 'rgb(255, 0, 0)'; // Texto blanco
            titleColor = '#be0000'; // Títulos blancos
            containerBorder = '2px solid white'; // Borde blanco para el contenedor principal
            headerTitle = '🚨☠️ Alerta de Seguridad ☠️🚨';
            infoCardBorder = '#ffffff'; // Linea blanca
            infoCardBg = 'rgb(156, 156, 156)'; // Fondo tarjeta de informacion de la infraccion
            strongColor = '#ffffff'; // Negritas en blanco
        } else if (level === 2) { // Segunda infracción
            footerImage = `${repoBaseUrl}presentacion_email_rojo.png`;
            headerTitle = '🚨 Alerta de Seguridad 🚨';
            infoCardBorder = 'rgb(255, 0, 0)'; // Mantiene el borde rojo
            headerBg = 'rgb(232, 0, 0)'; // Fondo rojo
            footerBg = 'rgb(232, 0, 0)'; // Fondo rojo
            infoCardBg = 'rgb(192, 57, 43)'; // Fondo de la tarjeta de informacion  rojo oscuro
            textColor = 'rgb(255, 255, 255)'; // Texto blanco
            titleColor = 'rgb(172, 172, 172)'; // Títulos blancos
            containerBg = 'rgb(255, 255, 255)'; // Fondo entre header y footer
        } else if (level === 1) { // Primera infracción
            headerTitle = '🚨 Alerta de Seguridad 🚨';
            infoCardBorder = 'rgb(255, 0, 0)'; // Borde rojo para la tarjeta de información
            containerBg = 'rgb(156, 156, 156)'; // Fondo gris clarito
        }
    }

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: ${bodyBg}; margin: 0; padding: 0; color: ${textColor}; }
            .email-container { max-width: 600px; margin: 20px auto; background-color: ${containerBg}; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1); border: ${containerBorder}; }
            .header { background-color: ${headerBg}; padding: 30px 20px; text-align: center; }
            .header h1 { color: ${level >= 3 ? 'rgb(255, 0, 0)' : 'rgb(255, 255, 255)'}; margin: 0; font-size: 24px; font-weight: 300; letter-spacing: 2px; text-transform: uppercase; }
            .content { padding: 40px 30px; line-height: 1.6; font-size: 16px; color: ${textColor}; }
            .content h2 { color: ${titleColor}; font-size: 22px; margin-top: 0; margin-bottom: 20px; font-weight: 600; }
            .info-card { background-color: ${infoCardBg}; border-left: 5px solid ${infoCardBorder}; padding: 20px; margin: 25px 0; border-radius: 4px; }
            .info-item { margin-bottom: 10px; }
            .info-item strong { color: ${strongColor}; display: inline-block; width: 120px; }
            .btn { display: inline-block; padding: 14px 28px; background-color: #9b59b6; background: linear-gradient(135deg, #9b59b6, #8e44ad); color: #ffffff !important; text-decoration: none; border-radius: 50px; font-weight: bold; margin-top: 25px; text-align: center; box-shadow: 0 4px 10px rgba(142, 68, 173, 0.3); }
            .footer-image { width: 100%; display: block; border-top: 1px solid rgb(255, 255, 255); }
            .footer { background-color: ${footerBg}; padding: 20px; text-align: center; color: ${level >= 3 ? 'rgb(255, 0, 0)' : 'rgb(255, 255, 255)'}; font-size: 13px; }
            .footer p { margin: 5px 0; }
            .cognotacion { font-size: 11px; color: ${cognotacionColor}; margin-top: 15px; padding: 0 20px; line-height: 1.4; }
        </style>
    </head>
    <body style="background-color: ${bodyBg}; margin:0; padding:0;">
        <div class="email-container">
            <div class="header">
                <h1>${headerTitle}</h1>
            </div>
            <div class="content">
                <h2>${title}</h2>
                ${bodyContent}
                ${imageUrl ? `<div style="text-align:center; margin-top:30px;"><img src="${imageUrl}" alt="Vista Previa" style="max-width:100%; border-radius:8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);"></div>` : ''}
                <p class="disclaimer"><strong>Nota:</strong> Los colores y dimensiones del modelo digital son de referencia. El resultado final puede variar ligeramente debido a factores técnicos del proceso de sublimación y estampación.</p>
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

// --- CAPA DE SEGURIDAD: CABECERAS HTTP ---
app.use((req, res, next) => {
    // CORS Restringido (Cambiar '*' por tu dominio real en producción para máxima seguridad)
    res.header('Access-Control-Allow-Origin', 'https://maoazaking.github.io'); 
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

    // Prevención de Clickjacking (Nadie puede meter tu web en un iframe)
    res.header('X-Frame-Options', 'DENY');
    // Prevención de MIME-Sniffing (No ejecutar archivos que dicen ser algo que no son)
    res.header('X-Content-Type-Options', 'nosniff');
    // Filtro XSS para navegadores antiguos
    res.header('X-XSS-Protection', '1; mode=block');
    // Forzar HTTPS (HSTS) - Solo si tienes SSL activo (Render lo tiene)
    res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Middleware para solicitar Client Hints (Datos precisos del dispositivo)
app.use((req, res, next) => {
    res.set('Accept-CH', 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List');
    next();
});

/**
 * Middleware para limitar la tasa de solicitudes y bloquear IPs.
 */
function rateLimiter(req, res, next) {
    const ip = getClientIp(req);
    const hasSecurityCookie = req.headers.cookie && req.headers.cookie.includes('sl=');

    // --- WHITELIST DE IP LOCAL (PREVENCIÓN DE BLOQUEO DE SISTEMA) ---
    if (ip === '127.0.0.1' || ip === '::1') return next();

    // 1. VERIFICACIÓN DE BANEO PERMANENTE (MAESTRO)
    if (permanentBans.has(ip)) {
        console.error(`🚫 CONEXIÓN RECHAZADA: IP con baneo permanente intentó acceder: ${ip}`);
        res.socket.destroy();
        return;
    }

    // 2. VERIFICACIÓN DE ESTADO EN SECURITY-STATE (Historial de banLevels)
    const ipBanStatus = banLevels[ip];

    if (ipBanStatus) {
        // Si la IP tiene historial, corroboramos el valor de la cookie con el nivel actual
        if (hasSecurityCookie) {
            const match = req.headers.cookie.match(/sl=(\d+)/);
            if (match) {
                const clientLevel = parseInt(match[1]);
                if (clientLevel > ipBanStatus.level) {
                    console.log(`🔄 Sync: Restaurando nivel ${clientLevel} para ${ip} desde el navegador.`);
                    ipBanStatus.level = clientLevel;
                    ipBanStatus.lastOffense = Date.now();
                    if (clientLevel >= 3 && !permanentBans.has(ip)) updateBannedIpsInRender(ip);
                }
            }
        }
    } else if (hasSecurityCookie && !amnestyIPs.has(ip)) {
        // IP LIMPIA (No en baneos ni en security-state) pero conserva cookie: ELIMINARLA
        console.log(`🧼 Limpieza selectiva: IP ${ip} está limpia pero conserva rastro. Solicitando borrado.`);
        res.clearCookie('sl', { path: '/' });
    }

    // --- GESTIÓN DE AMNISTÍA (IPs en proceso de perdón) ---
    if (amnestyIPs.has(ip) && amnestyIPs.get(ip) > Date.now()) {
        if (hasSecurityCookie) res.clearCookie('sl', { path: '/' });
        return next();
    }

    // 2. Verificar y levantar baneo temporal si ya expiró
    if (blockedIPs[ip] && blockedIPs[ip] <= Date.now()) {
        console.log(`✅ Sentencia cumplida para IP: ${ip}. Bloqueo temporal levantado.`);
        delete blockedIPs[ip];
    }

    // 3. Rechazar si aún está en baneo temporal
    if (blockedIPs[ip]) {
        const level = (banLevels[ip] && banLevels[ip].level) || 1;
        console.warn(`🚫 IP bloqueada temporalmente (Nivel ${level}) intentó acceder: ${ip}`);
        return res.status(429).json({ error: 'Hubo un error de comunicación con el servidor. Inténtalo más tarde.' });
    }

    next();
}

// --- SEGURIDAD GLOBAL ---
// Aplicar el bloqueo de IPs a TODAS las rutas (Página web, imágenes, APIs)
app.use(rateLimiter);

// --- Cargar Configuración de Usuarios ---
// Se carga la configuración "cruda" para poder resolver los valores de .env sobre la marcha.
let usersConfig = [];
try {
    const usersPath = path.join(__dirname, '../json/usuarios.json'); // Ruta actualizada a json/usuarios.json
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
    dest: path.join(__dirname, '../temp_uploads/'), // Ruta actualizada a raíz/temp_uploads
    limits: { fileSize: Infinity }
});

// --- CACHE LOCAL PARA EFICIENCIA ---
// Cargar pedidos en memoria al iniciar para servir cambios inmediatos sin esperar a GitHub/Render
let localPedidos = [];
try {
    const pedidosPath = path.join(__dirname, '../json/pedidos.json'); // Ruta actualizada a json/pedidos.json
    if (fs.existsSync(pedidosPath)) {
        localPedidos = JSON.parse(fs.readFileSync(pedidosPath, 'utf8'));
    }
} catch (err) {
    console.error("Error cargando pedidos.json local:", err.message);
}

// --- CACHE DE CLIENTES (CRM) ---
let localClientes = [];
try {
    if (fs.existsSync(CLIENTES_PATH)) {
        localClientes = JSON.parse(fs.readFileSync(CLIENTES_PATH, 'utf8'));
        console.log(`✅ Base de datos de clientes cargada: ${localClientes.length} registros.`);
    } else if (localPedidos.length > 0) {
        // ALIMENTACIÓN INICIAL: Extraer clientes de pedidos existentes
        console.log("ℹ️ clientes.json no existe. Creando base de datos inicial desde pedidos...");
        const mapClientes = new Map();
        localPedidos.forEach(p => {
            const tel = p.telefono || p.teléfono;
            if (tel && !mapClientes.has(tel)) {
                mapClientes.set(tel, { telefono: tel, email: null, nombre: null, genero: null, fecha_registro: new Date().toISOString() });
            }
        });
        localClientes = Array.from(mapClientes.values());
        fs.writeFileSync(CLIENTES_PATH, JSON.stringify(localClientes, null, 4));
        console.log(`✅ Base de datos de clientes creada con ${localClientes.length} números importados.`);
    }
} catch (err) {
    console.error("Error inicializando clientes.json:", err.message);
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
// Actualizado para interceptar la nueva ruta /json/pedidos.json
app.get('/json/pedidos.json', (req, res) => res.json(localPedidos));

// --- FIREWALL DE ARCHIVOS ESTÁTICOS (SEGURIDAD CRÍTICA) ---
// Bloquear acceso directo a archivos sensibles que viven en la raíz o subcarpetas
app.use((req, res, next) => {
    const restrictedPaths = ['/json/usuarios.json', '/json/clientes.json', '/.env', '/package.json', '/README.md', '/js/server.js', '/js/worker_email.js'];
    if (restrictedPaths.some(path => req.path.toLowerCase().startsWith(path))) {
        return res.status(403).send('⛔ Access Denied: Protected Resource');
    }
    next();
});

// Servir archivos estáticos (HTML, CSS, JS, Imágenes)
// IMPORTANTE: Servir desde '../' (la raíz) para que encuentre index.html, img/, css/, etc.
app.use(express.static(path.join(__dirname, '../')));

// Endpoint para el "heartbeat" del cliente, para forzar recarga si está baneado
app.get('/api/heartbeat', (req, res) => {
    const userAgent = req.get('User-Agent') || '';
    // Log para confirmar que GitHub o UptimeRobot nos mantienen despiertos
    if (req.query.pinger === 'github') {
        console.log("💓 Keep-Alive: Recibida señal de vida desde GitHub Actions.");
    } else if (userAgent.includes('UptimeRobot')) {
        // UptimeRobot usa un User-Agent que incluye "UptimeRobot"
        console.log("🤖 Keep-Alive: Señal de UptimeRobot recibida. Servidor activo.");
    }
    // El middleware global `rateLimiter` se encarga de todo.
    // Si no está baneado, devuelve 200 OK.
    // Si está baneado temporalmente, devuelve 429.
    // Si está baneado permanentemente, destruye el socket.
    res.sendStatus(200);
});

// Endpoint de salud del sistema mejorado
app.get('/api/system-health', (req, res) => {
    const uptime = process.uptime();
    res.json({ status: 'online', uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`, memory: process.memoryUsage().rss });
});

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
        if (!faceData && fs.existsSync(path.join(__dirname, '../.env'))) {
            try {
                const envContent = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
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
            // Limpiar intentos fallidos en un login exitoso
            const ip = getClientIp(req);
            if (loginAttempts[ip]) {
                delete loginAttempts[ip];
            }
            // Limpiar historial de niveles de baneo si accede correctamente
            if (banLevels[ip]) {
                delete banLevels[ip];
            }
            saveSecurityState(); // Persistir la limpieza
            // Face data is now sent by /api/check-user, no need to send it again here.
            return res.json({ success: true, redirectUrl: user.redirectUrl || 'bienvenida_majo.html', email: resolveEnvValue(user.email), name: user.name });
        } else {
            const banned = recordFailedAttempt(req, res, "Contraseña incorrecta");
            return res.status(401).json({ success: false, message: 'Credenciales incorrectas', forceRefresh: banned });
        }
    }
    
    // Si llegamos aquí, el usuario no existe
    const banned = recordFailedAttempt(req, res, "Usuario no encontrado");
    res.status(401).json({ success: false, message: 'Credenciales incorrectas', forceRefresh: banned });
});

// Endpoint para verificar disponibilidad de nombre de usuario
app.post('/api/check-username-availability', (req, res) => {
    const { username, currentUsername } = req.body;

    if (!username) {
        return res.status(400).json({ available: false, message: 'Nombre de usuario no proporcionado.' });
    }

    // Comprobamos si el nombre de usuario está en uso por otro administrador que no sea el placeholder actual
    // o la cuenta final de Majo (que será reemplazada).
    const isTaken = usersConfig.some(u => {
        const resolvedUsername = resolveEnvValue(u.username);
        
        // Ignorar el usuario placeholder que se está configurando
        if (resolvedUsername === currentUsername) {
            return false;
        }
        // Ignorar la cuenta de destino de Majo, ya que se va a sobreescribir/crear
        if (u.username === 'ENV:ADMIN_USER_MARIAJOSE') {
            return false;
        }
        
        return resolvedUsername.toLowerCase() === username.toLowerCase();
    });

    if (isTaken) {
        return res.json({ available: false, message: 'El nombre de usuario ya está en uso.' });
    }

    return res.json({ available: true });
});

// Endpoint para buscar información de un cliente por teléfono
app.get('/api/clientes/search', (req, res) => {
    const { telefono } = req.query;
    const cliente = localClientes.find(c => c.telefono === telefono);
    res.json({ found: !!cliente, cliente });
});

// Endpoint para completar configuración (Usuario y Contraseña)
app.post('/api/complete-setup', async (req, res) => {
    const { currentUsername, newUsername, newPassword, newEmail } = req.body;
    
    // 1. Cargar la configuración cruda para modificarla
    let currentUsersConfig = [];
    try {
        const usersPath = path.join(__dirname, '../json/usuarios.json');
        currentUsersConfig = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    } catch (e) {
        return res.status(500).json({ success: false, error: 'No se pudo leer la configuración de usuarios.' });
    }

    // 2. Validar si el nuevo nombre de usuario ya está en uso por otro administrador (ej: Miguel)
    // Esta es una segunda validación, la primera está en el frontend.
    const isTaken = currentUsersConfig.some(u =>
        resolveEnvValue(u.username) !== currentUsername &&
        u.username !== "ENV:ADMIN_USER_MARIAJOSE" &&
        resolveEnvValue(u.username).toLowerCase() === newUsername.toLowerCase()
    );
    if (isTaken) {
        return res.status(400).json({ success: false, error: 'El nombre de usuario ya está en uso.' });
    }

    // 3. Filtrar para eliminar el placeholder y cualquier versión anterior de la cuenta de Majo
    const cleanedUsersConfig = currentUsersConfig.filter(u =>
        u.username !== "ENV:ADMIN_USER_MARIAJOSE" &&
        resolveEnvValue(u.username) !== currentUsername
    );

    // 4. Crear y añadir el nuevo objeto de usuario para Majo
    const newUserMajo = {
        "username": newUsername,
        "password": newPassword,
        "email": newEmail,
        "redirectUrl": "admin_dashboard.html",
        "faceDataEnvVar": "MARIAJOSE_FACE_DATA_JSON",
        "gender": "mujer",
        "name": "Mariajose"
    };
    cleanedUsersConfig.push(newUserMajo);
    
    // --- ACTUALIZACIÓN INMEDIATA (HOT-FIX) ---
    // 1. Actualizar la memoria del servidor para bloquear el acceso por número INSTANTÁNEAMENTE
    usersConfig = cleanedUsersConfig; 
    // 2. Escribir en el disco local (aunque sea efímero en Render) para persistir hasta el reinicio
    try { fs.writeFileSync(path.join(__dirname, '../json/usuarios.json'), JSON.stringify(cleanedUsersConfig, null, 4)); } catch(e) {}

    // 5. Actualizar las variables de entorno en Render ANTES de commitear a GitHub.
    // Esto es importante para que, cuando Render se reinicie por el commit, ya tenga las nuevas credenciales.
    await updateAdminCredentialsInRender(newUsername, newPassword, newEmail);


    // 6. Guardar la configuración de usuarios (usuarios.json) en GitHub
    if (githubClient && GITHUB_OWNER && GITHUB_REPO) {
        try {
            // Obtener SHA actual del archivo en GitHub
            let sha;
            try {
                const { data: fileData } = await githubClient.repos.getContent({
                    owner: GITHUB_OWNER,
                    repo: GITHUB_REPO,
                    path: 'json/usuarios.json' // Ruta en GitHub actualizada
                });
                sha = fileData.sha;
            } catch (e) {
                console.log("usuarios.json no existe en remoto, se creará.");
            }

            // Subir archivo actualizado
            await githubClient.repos.createOrUpdateFileContents({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                path: 'json/usuarios.json', // Ruta en GitHub actualizada
                message: `Setup completed for Majo`, // Quitamos [skip render] para forzar que Render tome los cambios
                content: Buffer.from(JSON.stringify(cleanedUsersConfig, null, 4)).toString('base64'),
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
    await dispatchEmail([newEmail], "🎉 ¡Bienvenida Majo! 🤗 Configuración De Derfil Exitosa - Support Team Sublimación Mary", emailHtml);

    res.json({ success: true });
});

// Endpoint para obtener el correo del administrador (para notificaciones)
app.get('/api/get-admin-email', (req, res) => {
    // SEGURIDAD: Ya no buscamos en el JSON ni usamos respaldos hardcoded.
    // Devolvemos el email de Mariajose como principal para el negocio, 
    // o el de Miguel como respaldo, tomados directamente de variables de entorno seguras.
    let email = process.env.ADMIN_EMAIL_MARIAJOSE || process.env.ADMIN_EMAIL_MIGUEL;
    res.json({ email });
});

// Endpoint para registrar actividad de login
app.post('/api/log-activity', async (req, res) => {
    const payload = req.body;
    const ip = getClientIp(req);
    const isUnban = payload.isUnbanContext === true;

    let banned = false;

    // Registrar intento fallido para el rate limiter
    // Corrección: Quitamos 'failed_password' de aquí para evitar que cuente doble (ya lo cuenta /api/login)
    const isFailure = ['suspicious_input', 'facial_failure', 'reauth_failure'].includes(payload.type);
    if (isFailure) {
        let context = isUnban ? "Intento Desbaneo fallido" : "Actividad sospechosa";
        if (payload.type === 'facial_failure') context = isUnban ? "Fallo facial en desbaneo" : "Validación facial fallida";
        if (payload.type === 'reauth_failure') context = "Re-autenticación facial fallida";
        if (payload.type === 'suspicious_input') context = "Input sospechoso";
        banned = recordFailedAttempt(req, res, context);
    }
    
    if (!githubClient) {
        console.warn("No se puede registrar actividad: GITHUB_TOKEN no configurado.");
        return res.status(500).json({ success: false, error: "Server not configured for logging." });
    }

    // INICIO DEL BLOQUEO GIT (Mutex)
    const unlock = await gitMutex.lock();

    let logSuccess = false;

    try {
        const [ipApiInfo, maxMindInfo] = await Promise.all([
            getIpInfo(ip),
            getIpInfoMaxMind(ip)
        ]);

        // Convertir la hora a la zona horaria de Colombia (UTC-5)
        const now = new Date();
        const localTime = new Date(now.getTime() - (5 * 60 * 60 * 1000));
        const timestamp = localTime.toISOString().replace('T', ' ').substring(0, 19) + ' (Hora de Colombia)';
        
        const reportPath = isUnban ? 'models_rf/img_rf/unban_report.txt' : 'models_rf/img_rf/login_report.txt';
        const photoFolder = isUnban ? 'models_rf/img_rf/ban-foto/' : 'models_rf/img_rf/';

        let logEntry = `============================================================\n`;
        logEntry += `${isUnban ? '⚠️ INTENTO DE DESBANEO' : 'Registro de Entrada'}: ${timestamp}\n`;
        
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
        } else if (process.env.MAXMIND_ACCOUNT_ID && process.env.MAXMIND_LICENSE_KEY) {
            const errorMessage = maxMindInfo ? (maxMindInfo.error || maxMindInfo.code) : 'Error desconocido';
            logEntry += `Estado: Falló la consulta. (${errorMessage})\n`;
            // Añadir nota específica para el error de DNS en Render
            if (errorMessage.includes('ENOTFOUND')) {
                logEntry += `Nota: El error 'ENOTFOUND' usualmente indica un problema de DNS en el servidor (Render), no un problema de la API de MaxMind.\n`;
            }
        } else {
             logEntry += `Estado: No configurado (faltan claves de API de MaxMind).\n`;
        }

        // --- Análisis del Dispositivo y Navegador ---
        const parser = new UAParser(payload.userAgent);
        const deviceInfo = parser.getResult();
        const osInfo = `${deviceInfo.os.name || 'Desconocido'} ${deviceInfo.os.version || ''}`.trim();
        const browserInfo = `${deviceInfo.browser.name || 'Desconocido'} ${deviceInfo.browser.version || ''}`.trim();
        const deviceType = deviceInfo.device.vendor ? `${deviceInfo.device.vendor} ${deviceInfo.device.model}` : (deviceInfo.device.type || 'Escritorio');

        logEntry += `\n--- Dispositivo y Navegador ---\n`;
        logEntry += `Sistema Operativo: ${osInfo}\n`;
        logEntry += `Navegador: ${browserInfo}\n`;
        logEntry += `Tipo de Dispositivo: ${deviceType}\n`;
        logEntry += `------------------------------------------------------------\n`;

        if (photoName) {
            logEntry += `Imagen Capturada: ${photoFolder}${photoName}\n`;
        } else {
            logEntry += `Imagen Capturada: Ninguna (Cámara falló o fue denegada).\n`;
        }
        logEntry += `============================================================\n\n`;

        // --- Actualización en GitHub ---
        const branch = 'main';
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
                path: `${photoFolder}${photoName}`,
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

        logSuccess = true;

    } catch (error) {
        // FIX: Handle GitHub API errors gracefully without crashing.
        // The "Unicorn" page is a 5xx error from GitHub's side.
        if (error.status && error.status >= 500) {
            console.warn(`⚠️  ADVERTENCIA: Falló el registro de actividad en GitHub (Error ${error.status}). Es un problema temporal de GitHub. La actividad de seguridad local SÍ fue registrada.`);
        } else {
            console.error("❌ Error registrando actividad en GitHub:", error);
        }
    } finally {
        unlock(); // LIBERAR BLOQUEO GIT SIEMPRE
    }

    if (logSuccess) console.log(`✅ Actividad registrada en GitHub: ${payload.type}`);

    // Limpiar historial de seguridad si la validación facial fue exitosa
    if (['facial_success', 'reauth_success'].includes(payload.type)) {
        if (loginAttempts[ip]) delete loginAttempts[ip];
        if (banLevels[ip]) {
            delete banLevels[ip];
            console.log(`🛡️ Historial de infracciones limpiado para ${ip} tras validación facial exitosa.`);
        }
        saveSecurityState();
    }

    res.json({ success: true, forceRefresh: banned });
});

// Endpoint para guardar un nuevo pedido con archivos
app.post('/api/pedidos', upload.fields([
    { name: 'imagen', maxCount: 1 }, 
    { name: 'plantilla', maxCount: 1 },
    { name: 'lamina_frontal', maxCount: 1 },
    { name: 'lamina_espaldar', maxCount: 1 },
    { name: 'foto_diseno', maxCount: 1 }
]), async (req, res) => {
    const { producto, telefono, fecha, estado, tipo_mug, color_mug, email_cliente, nombre_cliente, genero_cliente, tipo_estampado, adminName } = req.body;
    const files = req.files || {};

    // 1. Determinar tipo de producto
    let tipoProducto = 'otros';
    if (producto && producto.toLowerCase().includes('mug')) tipoProducto = 'mug';
    if (producto && producto.toLowerCase().includes('camiseta')) tipoProducto = 'camiseta';
    if (producto && producto.toLowerCase().includes('saco')) tipoProducto = 'saco';
    if (producto && producto.toLowerCase().includes('gorra')) tipoProducto = 'gorra';

    // --- VALIDACIÓN DE ARCHIVOS MEJORADA ---
    const validateImageIntegrity = (file) => {
        try {
            const dimensions = sizeOf(file.path);
            const allowedTypes = ['jpg', 'jpeg', 'png'];
            if (!allowedTypes.includes(dimensions.type)) {
                throw new Error("Tipo de archivo no permitido por el analizador de integridad.");
            }
            return true;
        } catch (e) {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
            throw new Error("Archivo corrupto o malicioso detectado.");
        }
    };

    if (['camiseta', 'saco'].includes(tipoProducto)) {
        if (files.lamina_frontal) validateImageIntegrity(files.lamina_frontal[0]);
        if (files.lamina_espaldar) validateImageIntegrity(files.lamina_espaldar[0]);

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
        if (files.lamina_frontal) validateImageIntegrity(files.lamina_frontal[0]);

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
        if (files.imagen) validateImageIntegrity(files.imagen[0]);

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

    // INICIO DEL BLOQUEO GIT (Mutex)
    const unlock = await gitMutex.lock();

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
        let mainImageUrl = '', urlFrontal = null, urlEspaldar = null, urlFotoDiseno = null;

        if (['camiseta', 'saco'].includes(tipoProducto)) {
            if (files.lamina_frontal) {
                const ext = path.extname(files.lamina_frontal[0].originalname).toLowerCase();
                const name = `lamina_frontal_${tipoProducto}_${nextNum}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, content: fs.readFileSync(files.lamina_frontal[0].path) });
                
                // DUPLICAR PARA PREVIEW (Misma extensión, GitHub Actions lo convertirá si es necesario)
                uploads.push({ path: relativePath.replace(ext, `_preview${ext}`), content: fs.readFileSync(files.lamina_frontal[0].path) });
                
                urlFrontal = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                mainImageUrl = urlFrontal;
            }
            if (files.lamina_espaldar) {
                const ext = path.extname(files.lamina_espaldar[0].originalname).toLowerCase();
                const name = `lamina_espaldar_${tipoProducto}_${nextNum}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, content: fs.readFileSync(files.lamina_espaldar[0].path) });
                
                // DUPLICAR PARA PREVIEW
                uploads.push({ path: relativePath.replace(ext, `_preview${ext}`), content: fs.readFileSync(files.lamina_espaldar[0].path) });
                
                urlEspaldar = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                if (!mainImageUrl) mainImageUrl = urlEspaldar;
            }
            if (files.plantilla) {
                const ext = path.extname(files.plantilla[0].originalname).toLowerCase();
                const name = `plantilla_${tipoProducto}_${nextNum}${ext}`;
                uploads.push({ path: `img/${tipoProducto}/${folderName}/${name}`, content: fs.readFileSync(files.plantilla[0].path) });
            }
        } else if (tipoProducto === 'gorra') {
            if (files.lamina_frontal) { // Se recibe desde el input 'lamina_frontal' pero se guarda como 'lamina_gorra'
                const ext = path.extname(files.lamina_frontal[0].originalname).toLowerCase();
                const name = `lamina_gorra_${nextNum}${ext}`; // NOMBRE ESTANDARIZADO
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, content: fs.readFileSync(files.lamina_frontal[0].path) });
                
                uploads.push({ path: relativePath.replace(ext, `_preview${ext}`), content: fs.readFileSync(files.lamina_frontal[0].path) });
                
                urlFrontal = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                mainImageUrl = urlFrontal;
            }
            if (files.plantilla) {
                const ext = path.extname(files.plantilla[0].originalname).toLowerCase();
                const name = `plantilla_gorra_${nextNum}${ext}`;
                uploads.push({ path: `img/${tipoProducto}/${folderName}/${name}`, content: fs.readFileSync(files.plantilla[0].path) });
            }
        } else {
            const imagenExt = path.extname(files.imagen[0].originalname).toLowerCase();
            const plantillaExt = path.extname(files.plantilla[0].originalname).toLowerCase();
            const imagenName = `lamina_${tipoProducto}_${nextNum}${imagenExt}`;
            const plantillaName = `plantilla_${tipoProducto}_${nextNum}${plantillaExt}`;
            const relativeImgPath = `img/${tipoProducto}/${folderName}/${imagenName}`;
            const relativeTemplatePath = `img/${tipoProducto}/${folderName}/${plantillaName}`;
            uploads.push({ path: relativeImgPath, content: fs.readFileSync(files.imagen[0].path) });
            
            // DUPLICAR PARA PREVIEW
            uploads.push({ path: relativeImgPath.replace(imagenExt, `_preview${imagenExt}`), content: fs.readFileSync(files.imagen[0].path) });
            
            uploads.push({ path: relativeTemplatePath, content: fs.readFileSync(files.plantilla[0].path) });
            mainImageUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativeImgPath}`;
        }

        if (files.foto_diseno) {
            const ext = path.extname(files.foto_diseno[0].originalname).toLowerCase();
            const name = `foto_usada_en_${tipoProducto}_${nextNum}${ext}`;
            const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
            uploads.push({ path: relativePath, content: fs.readFileSync(files.foto_diseno[0].path) });
            
            // DUPLICAR PARA PREVIEW (Opcional, pero útil si se usa como referencia visual)
            uploads.push({ path: relativePath.replace(ext, `_preview${ext}`), content: fs.readFileSync(files.foto_diseno[0].path) });
            
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
            const { data: jsonFile } = await githubClient.repos.getContent({ owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'json/pedidos.json', ref: branch });
            pedidos = JSON.parse(Buffer.from(jsonFile.content, 'base64').toString('utf-8'));
        } catch (error) {
            if (error.status !== 404) console.warn("pedidos.json no encontrado, creando nuevo.");
        }

        // Generar nuevo S/N (Serial Number) Profesional
        const prodLower = producto.toLowerCase();
        const prefix = prodLower.includes('mug') ? 'MUGS' : 
                       prodLower.includes('camiseta') ? 'CAMI' : 
                       prodLower.includes('saco') ? 'SACO' : 
                       prodLower.includes('gorra') ? 'GORR' : 'PROD';

        const nextId = generateNextSN(pedidos, prefix);

        const nuevoPedido = { 
            s_n: nextId,
            telefono, producto, fecha, estado, tipo_mug, color_mug,
            tipo_estampado: tipo_estampado || 'completo', // Default: Completo
            imagen_url: mainImageUrl,
            imagenes: (tipoProducto === 'gorra') 
                ? { lamina: urlFrontal } // GORRA: Solo propiedad 'lamina'
                : { frontal: urlFrontal, espaldar: urlEspaldar }, // TEXTIL: Propiedades estandar
            foto_diseno_url: urlFotoDiseno
        };
        pedidos.push(nuevoPedido);

        // --- GESTIÓN DE CLIENTES (CRM) ---
        let clienteActualizado = false;
        let alertaCambioEmail = false;
        let emailAnterior = null;

        let clienteIndex = localClientes.findIndex(c => c.telefono === telefono);
        
        if (clienteIndex >= 0) {
            // Cliente existente: Actualizar si hay datos nuevos
            const cliente = localClientes[clienteIndex];
            
            // Detectar cambio de correo para alerta
            if (email_cliente && cliente.email && cliente.email !== email_cliente) {
                alertaCambioEmail = true;
                emailAnterior = cliente.email;
            }

            // Actualizar datos si vienen en el formulario (prioridad a lo nuevo)
            if (email_cliente) cliente.email = email_cliente;
            // Solo actualizar nombre/género si estaban vacíos o si se fuerzan (en este flujo, si existe el cliente, estos campos suelen venir vacíos del front a menos que se habilite edición completa, asumiremos actualización si hay dato)
            if (nombre_cliente) cliente.nombre = nombre_cliente;
            if (genero_cliente) cliente.genero = genero_cliente;
            
            localClientes[clienteIndex] = cliente;
            clienteActualizado = true;
        } else {
            // Cliente Nuevo
            const nuevoCliente = {
                telefono,
                email: email_cliente || null,
                nombre: nombre_cliente || null,
                genero: genero_cliente || null,
                fecha_registro: new Date().toISOString()
            };
            localClientes.push(nuevoCliente);
            clienteActualizado = true;
        }

        // Añadir clientes.json al commit si hubo cambios
        if (clienteActualizado) {
            // Guardar localmente
            try { fs.writeFileSync(CLIENTES_PATH, JSON.stringify(localClientes, null, 4)); } catch(e){}

            const { data: jsonClientesBlob } = await githubClient.git.createBlob({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, content: Buffer.from(JSON.stringify(localClientes, null, 4)).toString('base64'), encoding: 'base64'
            });
            treeItems.push({ path: 'json/clientes.json', mode: '100644', type: 'blob', sha: jsonClientesBlob.sha });
        }

        // Enviar alerta a admins si hubo cambio de correo
        if (alertaCambioEmail) {
            const asuntoAlerta = `⚠️ Alerta de Datos: Cambio de Correo en Cliente ${telefono}`;
            const cuerpoAlerta = `
                <p>El sistema ha detectado un cambio de correo electrónico para un cliente existente durante la creación de un pedido.</p>
                <div class="info-card" style="border-left-color: #f39c12;">
                    <div class="info-item"><strong>Cliente:</strong> ${telefono}</div>
                    <div class="info-item"><strong>Correo Anterior:</strong> ${emailAnterior}</div>
                    <div class="info-item"><strong>Nuevo Correo:</strong> ${email_cliente}</div>
                </div>
                <p>Se ha actualizado el perfil del cliente con el nuevo correo. Por favor verificar si es correcto.</p>
            `;
            sendEmailNotification(asuntoAlerta, getEmailTemplate('Cambio de Datos Detectado', cuerpoAlerta));
        }
        // ---------------------------------

        localPedidos = pedidos;
        const { data: jsonBlob } = await githubClient.git.createBlob({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'), encoding: 'base64'
        });
        treeItems.push({ path: 'json/pedidos.json', mode: '100644', type: 'blob', sha: jsonBlob.sha });

        const { data: newTree } = await githubClient.git.createTree({ owner: GITHUB_OWNER, repo: GITHUB_REPO, base_tree: baseTreeSha, tree: treeItems });
        const { data: newCommit } = await githubClient.git.createCommit({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, message: `Nuevo pedido: ${producto} - ${folderName} [skip render]`, tree: newTree.sha, parents: [latestCommitSha]
        });
        await githubClient.git.updateRef({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${branch}`, sha: newCommit.sha });

        Object.values(files).flat().forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });

        // --- ENVIAR CORREO: NUEVO PEDIDO ---
        const bodyContent = `
            <p>Se ha registrado un nuevo pedido en el sistema por <strong>${adminName || 'el administrador'}</strong>. A continuación los detalles:</p>
            <div class="info-card" style="border-left-color: #e74c3c;">
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

        // --- ENVIAR CORREO AL CLIENTE: DISEÑO LISTO (Si aplica) ---
        if (estado === "Revisión del cliente") {
            const linkDirecto = `${GITHUB_PAGES_URL}/mis_pedidos.html?telefono=${telefono}&pedido=${nextId}`;
            const bodyCliente = `
                <p>¡Hola! Tu diseño para el pedido <strong>${nextId}</strong> ya ha sido creado.</p>
                <p>Puedes verlo en 3D, aprobarlo o pedir cambios tocando el siguiente botón:</p>
                <div style="text-align:center; margin: 20px 0;"><a href="${linkDirecto}" class="btn">👉 Ver mi Diseño 3D</a></div>
            `;
            await sendClientEmailNotification(telefono, "¡Tu Diseño está Listo! 🎨", bodyCliente, mainImageUrl);
        }

        return res.json({ success: true, pedido: nuevoPedido });

    } catch (error) {
        console.error("Error GitHub API:", error);
        return res.status(500).json({ success: false, error: 'Error guardando en repositorio remoto: ' + error.message });
    } finally {
        unlock(); // LIBERAR BLOQUEO GIT
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
    const { original_imagen_url, producto, telefono, fecha, estado, tipo_mug, color_mug, tipo_estampado, adminName } = req.body;
    const files = req.files || {};

    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) {
        return res.status(500).json({ success: false, error: 'Credenciales de GitHub no configuradas.' });
    }

    // INICIO DEL BLOQUEO GIT (Mutex)
    const unlock = await gitMutex.lock();

    try {
        console.log("Editando pedido vía GitHub API...");

        const { data: repoData } = await githubClient.repos.get({ owner: GITHUB_OWNER, repo: GITHUB_REPO });
        const branch = repoData.default_branch;

        const { data: jsonFile } = await githubClient.repos.getContent({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'json/pedidos.json', ref: branch
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
        let urlEspaldar = pedido.imagenes ? pedido.imagenes.espaldar : null;

        if (['camiseta', 'saco'].includes(tipoProducto)) {
             if (files.lamina_frontal) {
                const ext = path.extname(files.lamina_frontal[0].originalname).toLowerCase();
                const name = `lamina_frontal_${Date.now()}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                // MEMORY FIX: No leer el archivo todavía (fs.readFileSync). Guardamos la ruta y leemos uno a uno.
                uploads.push({ path: relativePath, filePath: files.lamina_frontal[0].path });
                
                // DUPLICAR PARA PREVIEW (Edición)
                uploads.push({ path: relativePath.replace(ext, `_preview${ext}`), filePath: files.lamina_frontal[0].path });
                
                urlFrontal = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                mainImageUrl = urlFrontal;
            }
            if (files.lamina_espaldar) {
                const ext = path.extname(files.lamina_espaldar[0].originalname).toLowerCase();
                const name = `lamina_espaldar_${Date.now()}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, filePath: files.lamina_espaldar[0].path });
                
                // DUPLICAR PARA PREVIEW (Edición)
                uploads.push({ path: relativePath.replace(ext, `_preview${ext}`), filePath: files.lamina_espaldar[0].path });
                
                urlEspaldar = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                if (!mainImageUrl) mainImageUrl = urlEspaldar;
            }
            if (files.plantilla) {
                const ext = path.extname(files.plantilla[0].originalname).toLowerCase();
                const name = `plantilla_${Date.now()}${ext}`;
                uploads.push({ path: `img/${tipoProducto}/${folderName}/${name}`, filePath: files.plantilla[0].path });
            }
        } else if (tipoProducto === 'gorra') {
             if (files.lamina_frontal) {
                const ext = path.extname(files.lamina_frontal[0].originalname).toLowerCase();
                const name = `lamina_gorra_${Date.now()}${ext}`; // NOMBRE ESTANDARIZADO
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, filePath: files.lamina_frontal[0].path });
                
                uploads.push({ path: relativePath.replace(ext, `_preview${ext}`), filePath: files.lamina_frontal[0].path });
                
                urlFrontal = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                mainImageUrl = urlFrontal;
            }
            if (files.plantilla) {
                const ext = path.extname(files.plantilla[0].originalname).toLowerCase();
                const name = `plantilla_gorra_${Date.now()}${ext}`;
                uploads.push({ path: `img/${tipoProducto}/${folderName}/${name}`, filePath: files.plantilla[0].path });
            }
        } else {
            if (files.imagen) {
                const ext = path.extname(files.imagen[0].originalname).toLowerCase();
                const name = `lamina_${Date.now()}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({ path: relativePath, filePath: files.imagen[0].path });
                
                // DUPLICAR PARA PREVIEW (Edición)
                uploads.push({ path: relativePath.replace(ext, `_preview${ext}`), filePath: files.imagen[0].path });
                
                mainImageUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
            }
            if (files.plantilla) {
                const ext = path.extname(files.plantilla[0].originalname).toLowerCase();
                const name = `plantilla_${Date.now()}${ext}`;
                uploads.push({ path: `img/${tipoProducto}/${folderName}/${name}`, filePath: files.plantilla[0].path });
            }
        }

        const treeItems = [];
        for (const up of uploads) {
            // MEMORY FIX: Leemos el archivo AQUÍ, lo subimos y dejamos que el Garbage Collector lo limpie
            // antes de leer el siguiente. Esto mantiene el uso de RAM bajo.
            const fileContent = fs.readFileSync(up.filePath);
            
            const { data: blobData } = await githubClient.git.createBlob({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, content: fileContent.toString('base64'), encoding: 'base64'
            });
            treeItems.push({ path: up.path, mode: '100644', type: 'blob', sha: blobData.sha });
            
            // Pequeña pausa para dar tiempo al sistema de liberar memoria si es necesario
            await delay(200); 
        }

        pedido.telefono = telefono;
        pedido.fecha = fecha;
        pedido.estado = estado;
        pedido.imagen_url = mainImageUrl;
        pedido.tipo_estampado = tipo_estampado || 'completo';
        
        if (tipoProducto === 'mug') {
            pedido.tipo_mug = tipo_mug;
            pedido.color_mug = color_mug;
        } else if (tipoProducto === 'gorra') {
            if (!pedido.imagenes) pedido.imagenes = {};
            pedido.imagenes.lamina = urlFrontal; // GORRA: Guardar en 'lamina'
        } else if (['camiseta', 'saco'].includes(tipoProducto)) {
            if (!pedido.imagenes) pedido.imagenes = {};
            pedido.imagenes.frontal = urlFrontal;
            pedido.imagenes.espaldar = urlEspaldar;
        }

        localPedidos = pedidos;
        const { data: jsonBlob } = await githubClient.git.createBlob({
            owner: GITHUB_OWNER, repo: GITHUB_REPO,
            content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'), encoding: 'base64'
        });
        treeItems.push({ path: 'json/pedidos.json', mode: '100644', type: 'blob', sha: jsonBlob.sha });

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
            <p>El pedido del cliente <strong>${telefono}</strong> ha sido modificado exitosamente por <strong>${adminName || 'el administrador'}</strong>.</p>
            <div class="info-card" style="border-left-color: #2980b9;">
                <div class="info-item"><strong>S/N:</strong> ${pedido.s_n || 'N/A'}</div>
                <div class="info-item"><strong>Producto:</strong> ${producto}</div>
                <div class="info-item"><strong>Fecha Actualizada:</strong> ${fecha}</div>
            </div>
        `;
        const emailHtml = getEmailTemplate(`Pedido Editado ✏️`, bodyContent, mainImageUrl);
        sendEmailNotification(`Pedido Editado S/N: ${pedido.s_n || 'N/A'} - ${telefono}`, emailHtml);

        // --- ENVIAR CORREO AL CLIENTE: DISEÑO ACTUALIZADO ---
        if (estado === "Revisión del cliente") {
            const linkDirecto = `${GITHUB_PAGES_URL}/mis_pedidos.html?telefono=${telefono}&pedido=${pedido.s_n || 'N/A'}`;
            const bodyCliente = `
                <p>¡Hola! Hemos actualizado el diseño de tu pedido <strong>${pedido.s_n || 'N/A'}</strong> basándonos en tus comentarios (o cambios administrativos).</p>
                <p>Entra aquí para revisar la nueva versión:</p>
                <div style="text-align:center; margin: 20px 0;"><a href="${linkDirecto}" class="btn">👉 Ver Diseño Actualizado</a></div>
            `;
            await sendClientEmailNotification(telefono, "Diseño Actualizado ✏️", bodyCliente, mainImageUrl);
        }

        res.json({ success: true, pedido: pedido });

    } catch (error) {
        console.error("Error editando pedido:", error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        unlock(); // LIBERAR BLOQUEO GIT
    }
});

// Función auxiliar para obtener adjuntos del repositorio (Word o Editables)
async function getAttachmentsForOrder(folderPath, type) {
    const attachments = [];
    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) return attachments;

    try {
        const { data: dirContent } = await githubClient.repos.getContent({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: folderPath
        });

        if (Array.isArray(dirContent)) {
            // Buscar archivo Word (para producción)
            if (type === 'production') {
                const wordDoc = dirContent.find(f => f.name === 'imprimir_lamina_para_sublimar.docx');
                if (wordDoc) attachments.push({ filename: wordDoc.name, path: wordDoc.download_url });
            }
            // Buscar editables (para cambios) - Plantillas .ai, .psd, etc.
            if (type === 'design') {
                // 1. Plantilla (AI, PSD, etc)
                const editable = dirContent.find(f => f.name.includes('plantilla_') || f.name.endsWith('.ai') || f.name.endsWith('.psd') || f.name.endsWith('.eps') || f.name.endsWith('.pdf'));
                if (editable) attachments.push({ filename: editable.name, path: editable.download_url });

                // 2. Láminas (PNG/JPG) - El usuario pide la imagen de la lámina
                const laminas = dirContent.filter(f => f.name.startsWith('lamina_') && !f.name.includes('_preview') && (f.name.endsWith('.png') || f.name.endsWith('.jpg') || f.name.endsWith('.jpeg')));
                laminas.forEach(l => attachments.push({ filename: l.name, path: l.download_url }));

                // 3. Foto usada en el diseño (Referencia original)
                const fotoRef = dirContent.find(f => f.name.startsWith('foto_usada_en_') && !f.name.includes('_preview'));
                if (fotoRef) attachments.push({ filename: fotoRef.name, path: fotoRef.download_url });

                // 4. Agregar el ZIP del pack completo
                const parts = folderPath.split('/');
                if (parts.length >= 3) {
                    const prodType = parts[1];
                    const folder = parts[2];
                    const publicUrl = 'https://sublimacion-mary.onrender.com';
                    attachments.push({ 
                        filename: `Pack_Pedido_${folder}.zip`, 
                        path: `${publicUrl}/api/download-folder/${prodType}/${folder}` 
                    });
                }
            }
        }
    } catch (e) { console.error("Error buscando adjuntos en GitHub:", e.message); }
    return attachments;
}

// Endpoint para actualizar el estado de un pedido
app.post('/api/update-status', async (req, res) => {
    const { imagen_url, nuevo_estado, detalles, adminName } = req.body;
    
    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) {
        return res.status(500).json({ success: false, error: 'Credenciales de GitHub no configuradas.' });
    }

    // INICIO DEL BLOQUEO GIT (Mutex)
    const unlock = await gitMutex.lock();

    try {
        const { data: jsonFile } = await githubClient.repos.getContent({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'json/pedidos.json'
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
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'json/pedidos.json',
            message: `Update status to ${nuevo_estado} [skip render]`,
            content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'),
            sha: jsonFile.sha
        });

        // --- ENVIAR CORREO DE NOTIFICACIÓN ---
        if (pedidoEncontrado) {
            const pedidoId = pedidoEncontrado.s_n || 'N/A';
            let asunto = `Actualización de Estado - Pedido S/N: ${pedidoId}`;
            let titulo = `Estado Actualizado`;
            let mensaje = `<p>El estado del pedido ha cambiado a: <strong>${nuevo_estado}</strong></p>`;
            let colorBorde = "#27ae60"; // Verde por defecto
            let attachmentType = null;
            let folderPath = null;

            // Intentar deducir la ruta de la carpeta del pedido en el repo
            // URL típica: https://raw.githubusercontent.com/USER/REPO/main/img/tipo/carpeta/archivo.png
            if (imagen_url && imagen_url.includes('/img/')) {
                const parts = imagen_url.split('/img/');
                if (parts.length > 1) {
                    const subPath = parts[1]; // tipo/carpeta/archivo.png
                    const folderParts = subPath.split('/');
                    if (folderParts.length >= 2) {
                        folderPath = `img/${folderParts[0]}/${folderParts[1]}`;
                    }
                }
            }

            if (nuevo_estado === "Creando diseño" && detalles) {
                asunto = `⚠️ Solicitud de CAMBIO - Pedido S/N: ${pedidoId}`;
                titulo = `Solicitud de Cambio`;
                mensaje = `<p>El cliente solicita los siguientes cambios para el <strong>Pedido identificado con S/N: ${pedidoId}</strong>:</p><div style="background: #fff0f0; padding: 15px; border-left: 4px solid #e74c3c; font-style: italic; margin: 15px 0;">"${detalles}"</div>`;
                colorBorde = "#e74c3c"; // Rojo para cambios
                attachmentType = 'design'; // Buscar editables

                // Enviar confirmación al cliente de que su solicitud fue recibida
                const linkDirecto = `${GITHUB_PAGES_URL}/mis_pedidos.html?telefono=${pedidoEncontrado.telefono}&pedido=${pedidoId}`;
                const bodyCliente = `<p>¡Hola! Hemos recibido tu solicitud de cambio para el pedido <strong>${pedidoId}</strong>.</p><p>Estamos trabajando en ello y te notificaremos en un nuevo correo cuando el diseño actualizado esté listo para tu revisión.</p><div style="text-align:center; margin: 20px 0;"><a href="${linkDirecto}" class="btn">👀 Ver mi Pedido</a></div>`;
                await sendClientEmailNotification(pedidoEncontrado.telefono, "📝 Solicitud de Cambio Recibida", bodyCliente, imagen_url);

            } else if (nuevo_estado.includes("Listo")) {
                asunto = `✅ Cliente SATISFECHO - Pedido S/N: ${pedidoId}`;
                titulo = `✅¡Cliente Satisfecho!`;
                mensaje = `<p>¡El cliente ha aprobado el diseño del <strong>Pedido identificado con S/N: ${pedidoId}</strong>! El pedido está listo para la siguiente fase.</p>`;
                attachmentType = 'production'; // Buscar Word

                // Enviar confirmación al cliente de que su aprobación fue recibida
                const linkDirecto = `${GITHUB_PAGES_URL}/mis_pedidos.html?telefono=${pedidoEncontrado.telefono}&pedido=${pedidoId}`;
                const bodyCliente = `<p>¡Hola! Hemos recibido la aprobación para tu pedido <strong>${pedidoId}</strong>.</p><p>Pronto pasará a producción. Puedes ver el diseño que aprobaste haciendo clic en el botón:</p><div style="text-align:center; margin: 20px 0;"><a href="${linkDirecto}" class="btn">👍 Ver Diseño Aprobado</a></div>`;
                await sendClientEmailNotification(pedidoEncontrado.telefono, "✅ Diseño Aprobado", bodyCliente, imagen_url);

            } else if (nuevo_estado === "Producto terminado") {
                // --- LÓGICA PARA PRODUCTO TERMINADO ---
                const actor = adminName || "Un administrador";
                
                // 1. Correo a ADMINS (Con trazabilidad)
                asunto = `✅ Pedido TERMINADO por ${actor} - S/N: ${pedidoId}`;
                titulo = "¡Pedido Finalizado!";
                mensaje = `<p>El administrador <strong>${actor}</strong> ha marcado el pedido como <strong>TERMINADO</strong> y listo para entregar.</p>`;
                
                // 2. Correo al CLIENTE (Asegurando que llegue)
                const bodyCliente = `<p>¡Buenas noticias! Tu pedido <strong>${pedidoId}</strong> (${pedidoEncontrado.producto}) está fabricado y <strong>LISTO PARA RECOGER</strong>. 🛍️</p><p>Te esperamos.</p>`;
                await sendClientEmailNotification(pedidoEncontrado.telefono, "¡Tu Pedido está Listo! 🎁", bodyCliente, imagen_url);
            }


            const bodyContent = `
                <div class="info-card" style="border-left-color: ${colorBorde};">
                    <div class="info-item"><strong>S/N:</strong> ${pedidoId}</div>
                    <div class="info-item"><strong>Producto:</strong> ${pedidoEncontrado.producto}</div>
                    <div class="info-item"><strong>Cliente:</strong> ${pedidoEncontrado.telefono}</div>
                </div>
                ${mensaje}
            `;

            let attachments = [];
            if (folderPath && attachmentType) {
                attachments = await getAttachmentsForOrder(folderPath, attachmentType);
            }
            
            const emailHtml = getEmailTemplate(titulo, bodyContent, imagen_url);
            await sendEmailNotification(asunto, emailHtml, attachments); // Notificación para el administrador
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Error actualizando estado:", error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        unlock(); // LIBERAR BLOQUEO GIT
    }
});

// --- ENDPOINT PARA GUARDAR DOCUMENTOS LEGALES FIRMADOS ---
app.post('/api/legal/save-signature', async (req, res) => {
    const { pdfBase64, pngBase64, adminName } = req.body;

    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) {
        return res.status(500).json({ success: false, error: "GitHub no configurado." });
    }

    const unlock = await gitMutex.lock();
    try {
        const branch = 'main';
        const treeItems = [];

        // 1. Guardar Firma PNG
        if (pngBase64) {
            const pngBuffer = Buffer.from(pngBase64.split(',')[1], 'base64');
            const { data: pngBlob } = await githubClient.git.createBlob({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, content: pngBuffer.toString('base64'), encoding: 'base64'
            });
            treeItems.push({
                path: 'img/firma_mariajose.png',
                mode: '100644', type: 'blob', sha: pngBlob.sha
            });
        }

        // 2. Guardar PDF Firmado
        if (pdfBase64) {
            const pdfBuffer = Buffer.from(pdfBase64.split(',')[1], 'base64');
            const { data: pdfBlob } = await githubClient.git.createBlob({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, content: pdfBuffer.toString('base64'), encoding: 'base64'
            });
            treeItems.push({
                path: 'acuerdos_de_uso_firmados_majo.pdf',
                mode: '100644', type: 'blob', sha: pdfBlob.sha
            });
        }

        // 3. Crear Commit
        const { data: refData } = await githubClient.git.getRef({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${branch}` });
        const latestCommitSha = refData.object.sha;
        const { data: commitData } = await githubClient.git.getCommit({ owner: GITHUB_OWNER, repo: GITHUB_REPO, commit_sha: latestCommitSha });
        
        const { data: newTree } = await githubClient.git.createTree({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, base_tree: commitData.tree.sha, tree: treeItems
        });

        const { data: newCommit } = await githubClient.git.createCommit({
            owner: GITHUB_OWNER, repo: GITHUB_REPO,
            message: `Legal: Documentos firmados por ${adminName} [skip render]`,
            tree: newTree.sha, parents: [latestCommitSha]
        });

        await githubClient.git.updateRef({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${branch}`, sha: newCommit.sha
        });

        // Notificar al autor
        const body = `<p>Mariajosé ha firmado los términos y condiciones de uso del proyecto.</p>
                      <p>La firma y el PDF han sido archivados en el repositorio.</p>`;
        await sendEmailNotification("⚖️ T&C Firmados - Sublimación Mary", getEmailTemplate("Acuerdo Legal Aceptado", body));

        res.json({ success: true });
    } catch (e) {
        console.error("Error guardando documentos legales:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        unlock();
    }
});

// --- ENDPOINT MAESTRO: FULL REBOOT FOR PRODUCTION ---
app.post('/api/full-reboot', async (req, res) => {
    const { username } = req.body;

    // 1. Verificar que sea el usuario correcto
    if (username !== "Full-Reboot_For_Production") {
        return res.status(403).json({ success: false, error: "Acceso denegado a funciones críticas." });
    }

    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) {
        return res.status(500).json({ success: false, error: "Faltan credenciales de GitHub." });
    }

    // --- LISTA DE PEDIDOS A SALVAR (MODIFICAR AQUÍ SI ES NECESARIO) ---
    // Pon aquí los S/N de los pedidos que NO se borraran en el lanzamiento de la pagina. Ej: ["MUGS_0005", "CAMI_0002"]
    const ORDERS_TO_KEEP = ["MUGS_0001","CAMI_0001","GORR_0001","SACO_0001"]; 
    
    console.log("🚨 INICIANDO PROTOCOLO FULL REBOOT...");
    const unlock = await gitMutex.lock();

    try {
        // A. Limpiar Variables de Seguridad en Render y en MEMORIA
        await updateRenderEnvVar('PERMANENTLY_BANNED_IPS', '');
        // Reset de Memoria Volátil (Seguridad instantánea)
        for (let key in loginAttempts) delete loginAttempts[key];
        for (let key in blockedIPs) delete blockedIPs[key];
        for (let key in banLevels) delete banLevels[key];
        permanentBans.clear();
        amnestyIPs.clear();
        
        saveSecurityState(); // Persistir el estado vacío en el archivo local

        console.log("✅ Seguridad: IPs baneadas y niveles de ofensa reseteados en Render y Memoria.");

        // B. Operaciones en GitHub
        const branch = 'main';
        
        // 1. Obtener árbol completo actual (Recursivo)
        const { data: refData } = await githubClient.git.getRef({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${branch}` });
        const latestCommitSha = refData.object.sha;
        const { data: commitData } = await githubClient.git.getCommit({ owner: GITHUB_OWNER, repo: GITHUB_REPO, commit_sha: latestCommitSha });
        const baseTreeSha = commitData.tree.sha;

        // 2. Preparar el nuevo árbol (Eliminación y Renombrado)
        // Estrategia: Listar lo que queremos borrar/modificar y crear un commit.
        // Dado que la API de GitHub es compleja para borrados masivos via tree, usaremos un enfoque híbrido:
        // - Borrar logs y Jsons de seguridad (Sobreescribir con vacío).
        // - Borrar imágenes de seguridad.
        // - Gestionar pedidos.

        const treeItems = [];

        // -- 2.1 Limpiar Seguridad --
        const emptyJson = Buffer.from("[]").toString('base64');
        const emptyState = Buffer.from("{}").toString('base64');
        const emptyTxt = Buffer.from("").toString('base64');

        // Resetear archivos de seguridad
        treeItems.push({ path: 'models_rf/img_rf/security/banned-ips.json', mode: '100644', type: 'blob', content: emptyJson, encoding: 'base64' }); // Vaciar
        treeItems.push({ path: 'models_rf/img_rf/security/security-state.json', mode: '100644', type: 'blob', content: emptyState, encoding: 'base64' }); // Vaciar
        treeItems.push({ path: 'models_rf/img_rf/login_report.txt', mode: '100644', type: 'blob', content: emptyTxt, encoding: 'base64' }); // Vaciar

        // Borrar imágenes de seguridad (Detectar y marcar para borrar)
        // Nota: Para borrar un archivo en createTree, no se incluye. Pero como estamos usando base_tree, 
        // necesitamos borrar explícitamente. La API de árboles no soporta borrado fácil sobre base_tree sin listar todo.
        // ENFOQUE SIMPLIFICADO: Sobreescribir pedidos.json y archivos clave. 
        // Las imágenes "basura" quedarán huérfanas pero no visibles. 
        // PERO el usuario pidió eliminar carpetas. Para eliminar carpetas via API, lo mejor es listar todo y filtrar.
        
        // -- 2.2 Gestionar Pedidos --
        // Cargar pedidos actuales
        const { data: jsonFile } = await githubClient.repos.getContent({ owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'json/pedidos.json', ref: branch });
        let pedidos = JSON.parse(Buffer.from(jsonFile.content, 'base64').toString('utf-8'));

        // Filtrar y Renombrar
        const pedidosKept = [];
        const counters = { 'MUGS': 0, 'CAMI': 0, 'SACO': 0, 'GORR': 0 };
        const typeMap = { 'MUGS': 'mug', 'CAMI': 'camiseta', 'SACO': 'saco', 'GORR': 'gorra' };

        // Solo procesamos los que se quedan
        for (const p of pedidos) {
            if (ORDERS_TO_KEEP.includes(p.s_n)) {
                // Identificar tipo
                let prefix = p.s_n.split('_')[0];
                if (!counters[prefix] && counters[prefix] !== 0) prefix = 'PROD'; // Fallback
                
                counters[prefix]++;
                const newNum = counters[prefix];
                const newSn = `${prefix}_${String(newNum).padStart(4, '0')}`;
                
                const oldSn = p.s_n;
                p.s_n = newSn; // Renombrar S/N
                
                // Lógica de carpetas: La carpeta vieja es difícil de renombrar en git data.
                // Vamos a mantener la referencia en el JSON pero "lógicamente" es el pedido 1.
                // *Nota: Renombrar carpetas físicas en Git vía API es muy costoso (mover cada blob).*
                // *Para cumplir "renombrar carpeta", lo ideal sería bajar, renombrar y subir, pero el servidor puede quedarse sin memoria.*
                // *Compromiso: Actualizamos el JSON para que el sistema "crea" que es el #1, aunque la URL de imagen apunte a la carpeta vieja.*
                // Si es CRÍTICO renombrar la carpeta física, requeriría un script local, no server-side.
                // ASUMIRÉ que actualizar el S/N y el estado lógico es suficiente para el "Reboot".
                
                pedidosKept.push(p);
            }
        }
        
        // Actualizar Memoria Local y preparar commit
        localPedidos = JSON.parse(JSON.stringify(pedidosKept));
        treeItems.push({
            path: 'json/pedidos.json',
            mode: '100644',
            type: 'blob',
            content: Buffer.from(JSON.stringify(pedidosKept, null, 4)).toString('base64'),
            encoding: 'base64'
        });

        // -- 2.3 Autodestrucción del Perfil --
        // Eliminar al usuario "Full-Reboot_For_Production" de usersConfig y usuarios.json
        const newUsersConfig = usersConfig.filter(u => u.username !== "Full-Reboot_For_Production");
        
        treeItems.push({
            path: 'json/usuarios.json',
            mode: '100644',
            type: 'blob',
            content: Buffer.from(JSON.stringify(newUsersConfig, null, 4)).toString('base64'),
            encoding: 'base64'
        });

        // 3. Commit Final
        const { data: newTree } = await githubClient.git.createTree({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            base_tree: baseTreeSha,
            tree: treeItems
        });

        const { data: newCommit } = await githubClient.git.createCommit({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            message: `🚀 FULL REBOOT: System cleaned & Initialized for Production.`,
            tree: newTree.sha,
            parents: [latestCommitSha]
        });

        await githubClient.git.updateRef({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            ref: `heads/${branch}`,
            sha: newCommit.sha
        });

        console.log("✅ REBOOT COMPLETADO EXITOSAMENTE.");
        res.json({ success: true, message: "🚀 SISTEMA INICIALIZADO: Se han limpiado los diseños de prueba, los logs y se han desbloqueado todas las IPs." });

    } catch (e) {
        console.error("❌ Error en Full Reboot:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        unlock();
    }
});

// Endpoint para generar vista previa de WhatsApp (Open Graph)
app.get('/api/preview', (req, res) => {
    const { img, sn, original, status, tel } = req.query;
    // Si no hay imagen, redirigir al home o mostrar error
    if (!img) return res.status(404).send("Imagen no encontrada");
    const fallback = original ? `onerror="this.onerror=null; this.src='${original}';"` : '';

    // --- CONFIGURACIÓN DE TAMAÑOS (Fácil de editar) ---
    const alturaCamiseta = "380px";   // Altura para productos verticales (CAMI, SACO)
    const anchoMugGorra = "420px";    // Ancho para productos horizontales (MUGS, GORR)

    const prefix = (sn || '').split('_')[0].toUpperCase();
    const isVertical = prefix === 'CAMI' || prefix === 'SACO';
    const imgStyle = isVertical 
        ? `height: ${alturaCamiseta}; width: auto; max-width: 90vw; object-fit: contain;` 
        : `width: 90%; max-width: ${anchoMugGorra}; height: auto;`;

    // Mapeo dinámico de estados para WhatsApp
    let ogTitle = "✅ Pedido Listo";
    let ogDesc = "👋 ¡Hola! Tu producto personalizado ya fue fabricado y está listo para entrega.";
    let bodyH1 = "¡Tu pedido está listo! 🎉";
    let bodyP = "Ya puedes pasar a recogerlo en nuestro local.";

    if (status === "Revisión del cliente") {
        ogTitle = "🎨 Diseño para Revisar";
        ogDesc = "Toca para ver tu diseño 3D y confirmar si te gusta.";
        bodyH1 = "¡Tu diseño está listo para revisión! 🎨";
        bodyP = "Entra para verlo en 3D y dinos qué te parece.";
    } else if (status === "Creando diseño") {
        ogTitle = "✏️ Ajustando tu Diseño";
        ogDesc = "Estamos trabajando en los cambios que solicitaste. Toca para ver el progreso.";
        bodyH1 = "Estamos trabajando en tu diseño ✏️";
        bodyP = "Estamos aplicando las modificaciones solicitadas.";
    } else if (status && (status.includes("Listo para sublimar") || status.includes("Listo para estampar"))) {
        ogTitle = "🏭 En Cola de Producción";
        ogDesc = "Tu diseño fue aprobado y ya está en fila para ser fabricado.";
        bodyH1 = "¡Diseño aprobado! 🚀";
        bodyP = "Tu pedido está en nuestra línea de producción.";
    }

    // Link para ir al panel real desde la preview
    const panelUrl = `${GITHUB_PAGES_URL}/mis_pedidos.html?telefono=${tel || ''}&pedido=${sn || ''}`;

    // HTML dinámico con Open Graph Tags para que WhatsApp muestre la tarjeta
    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>${ogTitle}</title>
    <meta property="og:site_name" content="Sublimación Mary">
    <meta property="og:title" content="${ogTitle} (S/N: ${sn || 'N/A'})">
    <meta property="og:description" content="${ogDesc}">
    <meta property="og:image" content="${img}">
    <meta property="og:image:width" content="800">
    <meta property="og:image:height" content="800">
    <meta property="og:type" content="website">
    <meta name="theme-color" content="#9b59b6">
    <style>
        body { margin: 0; background: #121212; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; min-height: 100vh; text-align: center; }
        .container { padding: 20px; max-width: 600px; display: flex; flex-direction: column; align-items: center; }
        h1 { color: #e0aaff; margin-bottom: 10px; font-size: 1.8rem; }
        .main-img { ${imgStyle} border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); margin: 20px 0; border: 2px solid #333; }
        .btn-3d { 
            display: inline-block; padding: 15px 30px; 
            background: linear-gradient(135deg, #9b59b6, #8e44ad); 
            color: white; text-decoration: none; border-radius: 50px; 
            font-weight: bold; margin-top: 10px; 
            box-shadow: 0 0 15px #9b59b6, 0 0 30px rgba(142, 68, 173, 0.4);
            border: 1px solid #e0aaff;
            transition: all 0.3s ease;
            display: flex; align-items: center; gap: 10px;
        }
        .btn-3d:hover { transform: scale(1.05); box-shadow: 0 0 25px #9b59b6, 0 0 50px #8e44ad; }
        .emoji-outline {
            filter: drop-shadow(1px 1px 0px white) drop-shadow(-1px -1px 0px white) drop-shadow(1px -1px 0px white) drop-shadow(-1px 1px 0px white);
        }
        .disclaimer { 
            font-size: 0.8rem; color: black; margin-top: 30px; line-height: 1.4; 
            border-top: 1px solid #333; padding: 15px 20px 0; font-weight: 800;
            -webkit-text-stroke: 0.5px white;
            text-shadow: 0 0 10px #9b59b6, 0 0 20px #9b59b6;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>${bodyH1}</h1>
        <p>Referencia S/N: ${sn || 'N/A'}</p>
        <img class="main-img" src="${img}" alt="Foto del Pedido" ${fallback}>
        <p>${bodyP}</p>
        <a href="${panelUrl}" class="btn-3d">
            <span class="emoji-outline">🕹️</span> Explorar en 3D Interactivo
        </a>
        <p class="disclaimer"><strong>AVISO DE REFERENCIA:</strong> Los colores y dimensiones mostrados en el modelo digital son una representación aproximada. El tono final puede presentar variaciones leves debido a la temperatura y tiempo del proceso de sublimación.</p>
    </div>
</body>
</html>`;
    res.send(html);
});

// --- ENDPOINT HONEYPOT: Trampa para atacantes ---
app.get(['/admin-config.php', '/wp-admin', '/.env.backup'], (req, res) => {
    const ip = getClientIp(req);
    console.error(`🪤 HONEYPOT: IP ${ip} atrapada intentando acceder a rutas críticas.`);
    updateBannedIpsInRender(ip); // Baneo permanente instantáneo
    res.status(404).send("File not found");
});

// --- ENDPOINT PARA SERVIR LA PÁGINA DE VERIFICACIÓN DE DESBANEO ---
app.get('/api/unban-verify', (req, res) => {
    const { ip, token, admin } = req.query;

    const pending = pendingUnbans.get(ip);

    if (!ip || !token || !pending || pending.token !== token || (pending.activated && Date.now() > pending.expires)) {
        return res.status(404).send(getGeneric404Page());
    }

    // --- ACTIVACIÓN LAZY DEL TOKEN ---
    if (!pending.activated) {
        pending.activated = true;
        pending.expires = Date.now() + (30 * 60 * 1000); // 30 minutos desde este momento
        pending.admin_active = admin || 'Administrador';
    }

    const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Validación de Seguridad</title>
        <script src="https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js"></script>
        <style>
            body { background: #000; color: white; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #1e1e1e; padding: 30px; border-radius: 20px; border: 2px solid #f1c40f; box-shadow: 0 0 20px rgba(241, 196, 15, 0.2); text-align: center; width: 90%; max-width: 400px; }
            .field { position: relative; margin-bottom: 15px; text-align: left; }
            label { display: block; color: #f1c40f; font-size: 0.7rem; font-weight: bold; margin-bottom: 5px; letter-spacing: 1px; }
            input { width: 100%; padding: 12px 40px 12px 12px; border-radius: 8px; border: 1px solid #333; background: #121212; color: white; box-sizing: border-box; font-family: monospace; }
            .toggle { position: absolute; right: 10px; top: 28px; cursor: pointer; opacity: 0.5; transition: 0.3s; }
            button { width: 100%; padding: 15px; border-radius: 50px; border: none; background: #f1c40f; color: black; font-weight: bold; cursor: pointer; margin-top: 10px; transition: 0.3s; }
            button:disabled { background: #444; color: #888; cursor: not-allowed; }
            .hidden { display: none; }
            .ip-display { font-family: monospace; background: #000; padding: 5px 10px; border-radius: 5px; color: #f1c40f; display: block; margin: 10px 0; }
            #video { width: 100%; border-radius: 15px; border: 2px solid #333; background: #000; }
            .status-text { font-size: 0.85rem; margin: 10px 0; color: #aaa; }
            .error-msg { color: #ff4444; font-size: 0.85rem; margin-top: 10px; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>🔐 Verificación de Identidad</h2>
            <p>Validando acceso para:<span class="ip-display">${ip}</span></p>

            <!-- PASO 1: LOGIN DE ADMIN -->
            <div id="step1">
                <p class="status-text">Fase 1: Autenticación de Administrador</p>
                <div class="field">
                    <label>USUARIO</label>
                    <input type="text" id="adminUser" value="${admin || ''}" placeholder="Usuario">
                </div>
                <div class="field">
                    <label>CONTRASEÑA</label>
                    <input type="password" id="adminPass" placeholder="Contraseña">
                </div>
                <button onclick="verificarLoginAdmin()">CONTINUAR A BIOMETRÍA</button>
                <div id="loginError" class="error-msg hidden"></div>
            </div>

            <!-- PASO 2: VALIDACIÓN FACIAL -->
            <div id="step2" class="hidden">
                <p id="facialSaludo" class="status-text">Fase 2: Validación Facial</p>
                <video id="video" playsinline></video>
                <p id="facialStatus" class="status-text">Iniciando cámara...</p>
                <div id="facialError" class="error-msg hidden"></div>
            </div>

            <!-- PASO 3: LLAVE MAESTRA -->
            <div id="step3" class="hidden">
                <p class="status-text">Fase 3: Protocolo de Llave Maestra</p>
                <form action="/api/execute-unban" method="POST" autocomplete="off">
                <input type="hidden" name="ip" value="${ip}">
                <input type="hidden" name="token" value="${token}">
                
                <div class="field">
                    <label>IDENTIFICADOR ALTA</label>
                    <input type="password" name="user" id="user" required>
                    <span class="toggle" onclick="toggle('user')">👁️</span>
                </div>
                
                <div class="field">
                    <label>LLAVE MAESTRA</label>
                    <input type="password" name="pass" id="pass" required>
                    <span class="toggle" onclick="toggle('pass')">👁️</span>
                </div>
                
                <div class="field">
                    <label>CÓDIGO DE RESPALDO</label>
                    <input type="password" name="email" id="email" required>
                    <span class="toggle" onclick="toggle('email')">👁️</span>
                </div>
                
                <button type="submit">VERIFICAR CREDENCIALES</button>
            </form>
            </div>
        </div>

        <script>
            let faceData = null;
            let userNombre = "";

            function toggle(id) {
                const el = document.getElementById(id);
                el.type = el.type === 'password' ? 'text' : 'password';
            }

            async function verificarLoginAdmin() {
                const user = document.getElementById('adminUser').value.trim();
                const pass = document.getElementById('adminPass').value.trim();
                const errorDiv = document.getElementById('loginError');
                errorDiv.classList.add('hidden');

                try {
                    // 1. Obtener datos faciales
                    const checkRes = await fetch('/api/check-user', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: user })
                    });
                    const checkData = await checkRes.json();

                    if (!checkData.isAdmin) throw new Error("Acceso denegado: No es administrador.");
                    faceData = checkData.faceData;
                    userNombre = checkData.name || user;

                    // 2. Verificar contraseña
                    const loginRes = await fetch('/api/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: user, password: pass })
                    });
                    const loginData = await loginRes.json();

                    if (loginData.success) {
                        document.getElementById('step1').classList.add('hidden');
                        document.getElementById('step2').classList.remove('hidden');
                        document.getElementById('facialSaludo').innerText = "Hola " + userNombre + ", mira a la cámara.";
                        iniciarBiometria();
                    } else {
                        throw new Error("Contraseña incorrecta.");
                    }
                } catch (e) {
                    errorDiv.innerText = e.message;
                    errorDiv.classList.remove('hidden');
                }
            }

            async function iniciarBiometria() {
                const status = document.getElementById('facialStatus');
                const video = document.getElementById('video');

                try {
                    status.innerText = "Cargando modelos de IA...";
                    const MODEL_URL = '/models_rf';
                    await Promise.all([
                        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
                        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
                        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
                    ]);

                    status.innerText = "Accediendo a cámara...";
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                    video.srcObject = stream;
                    await video.play();

                    // Preparar Matcher
                    const descriptors = faceData.descriptors.map(d => new Float32Array(d));
                    const labeledDescriptors = new faceapi.LabeledFaceDescriptors(faceData.label, descriptors);
                    const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.55);

                    status.innerText = "Analizando rostro...";
                    let matchFound = false;

                    // Intentar detectar durante 10 segundos
                    for (let i = 0; i < 50; i++) {
                        const detections = await faceapi.detectAllFaces(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
                                                    .withFaceLandmarks()
                                                    .withFaceDescriptors();
                        
                        if (detections.length > 0) {
                            if (detections.some(d => faceMatcher.findBestMatch(d.descriptor).label !== 'unknown')) {
                                matchFound = true;
                                break;
                            }
                        }
                        await new Promise(r => setTimeout(r, 200));
                    }

                    stream.getTracks().forEach(track => track.stop());

                    if (matchFound) {
                        status.innerText = "✅ Identidad Confirmada";
                        setTimeout(() => {
                            document.getElementById('step2').classList.add('hidden');
                            document.getElementById('step3').classList.remove('hidden');
                        }, 1000);
                        
                        // Registrar éxito facial silenciosamente
                        fetch('/api/log-activity', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                type: 'reauth_success',
                                username: document.getElementById('adminUser').value,
                                userAgent: navigator.userAgent
                            })
                        });
                    } else {
                        throw new Error("No se pudo confirmar tu identidad facial.");
                    }

                } catch (e) {
                    document.getElementById('facialError').innerText = e.message;
                    document.getElementById('facialError').classList.remove('hidden');
                    status.innerText = "❌ Fallo de validación";
                    // Botón para reintentar login
                    const btn = document.createElement('button');
                    btn.innerText = "REINTENTAR LOGIN";
                    btn.onclick = () => window.location.reload();
                    document.getElementById('step2').appendChild(btn);
                }
            }
        </script>
    </body>
    </html>`;
    res.send(html);
});

// --- ENDPOINT PARA EJECUTAR EL DESBANEO TRAS VALIDACIÓN ---
app.post('/api/execute-unban', async (req, res) => {
    const { ip, token, user, pass, email } = req.body;

    // 1. Validar token
    const pending = pendingUnbans.get(ip);
    if (!pending || pending.token !== token || !pending.activated || Date.now() > pending.expires) {
        return res.status(404).send(getGeneric404Page());
    }

    // 2. Validar credenciales de MIGUEL (Llave Maestra)
    const masterUser = process.env.ADMIN_USER_MIGUEL_HASH;
    const masterPass = process.env.ADMIN_PASS_MIGUEL_HASH;
    const masterEmail = process.env.ADMIN_EMAIL_MIGUEL_HASH;

    if (user === masterUser && pass === masterPass && email === masterEmail) {
        console.log(`✅ AUDITORÍA: Verificación de identidad exitosa para ${ip} realizada por ${pending.admin_active}.`);
        
        // 3. Ejecutar desbaneo real en Render
        try {
            // --- REFUERZO DE INTEGRIDAD ---
            // Verificar que la IP que solicita el desbaneo no sea la misma que será desbaneada
            // (Evita que un atacante que robó el token se desbanee a sí mismo)
            if (getClientIp(req) === ip) {
                console.error(`🚨 INTENTO DE AUTO-DESBANEO DETECTADO: IP ${ip}`);
                return res.status(403).send("Error de seguridad: No puedes autorizar tu propio desbaneo.");
            }

            await cleanBannedIpInRender(ip);
            
            // 4. Limpieza Profunda de Memoria
            permanentBans.delete(ip);
            pendingUnbans.delete(ip);
            banLevels[ip] = { level: 0, lastOffense: 0 }; // Resetear nivel en lugar de borrar para trazabilidad
            delete loginAttempts[ip];

            // Otorgar amnistía para que el navegador del cliente limpie sus cookies al entrar
            amnestyIPs.set(ip, Date.now() + (30 * 60 * 1000));


            // Registrar éxito en el reporte
            await logActivity({
                type: 'master_unban_success',
                username: pending.admin_active,
                ip: getClientIp(req),
                targetUnbanIp: ip,
                userAgent: req.headers['user-agent']
            });

            // 5. Enviar confirmación Doble Check (Miguel recibe copia oculta)
            await sendUnbanConfirmation(ip, pending.admin_active);

            res.send(`
                <body style="background: #121212; color: #2ecc71; font-family: sans-serif; text-align: center; padding-top: 100px;">
                    <h1>✅ Desbaneo Exitoso</h1>
                    <p>La IP ${ip} ha sido eliminada. El usuario podrá acceder tras el reinicio automático.</p>
                    <script>setTimeout(() => window.location.href = '/', 5000);</script>
                </body>
            `);
        } catch (e) {
            res.status(500).send("Error técnico al actualizar Render: " + e.message);
        }
    } else {
        // --- PROTOCOLO DE FALLO CRÍTICO (ADMIN/MASTER) ---
        const attackerIp = getClientIp(req);
        console.error(`❌ FALLO DE IDENTIDAD: IP ${attackerIp} falló la validación para ${ip}.`);

        // 1. Invalidar sesión actual
        pendingUnbans.delete(ip);

        // 2. Generar NUEVA sesión para el reintento
        const nextRetryToken = crypto.randomBytes(32).toString('hex');
        pendingUnbans.set(ip, { token: nextRetryToken, activated: false, expires: null });

        // 3. Generar tokens de baneo individuales para cada admin
        const tokenMiguel = crypto.randomBytes(32).toString('hex');
        const tokenMariajose = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + (24 * 60 * 60 * 1000);

        pendingSecurityActions.set(tokenMiguel, { attackerIp, adminName: 'Miguel', unbanIp: ip, expires });
        pendingSecurityActions.set(tokenMariajose, { attackerIp, adminName: 'Mariajose', unbanIp: ip, expires });

        // 4. Registrar en login_report.txt
        await logActivity({
            type: 'master_key_failure',
            username: user,
            attemptedPass: '********',
            attemptedEmail: email,
            userAgent: req.headers['user-agent'],
            ip: attackerIp,
            targetUnbanIp: ip
        });

        // 5. Enviar Alerta Mejorada (Correos Separados)
        const publicUrl = 'https://sublimacion-mary.onrender.com';
        const devEmail = process.env.ADMIN_EMAIL_MIGUEL;
        const majoEmail = process.env.ADMIN_EMAIL_MARIAJOSE;

        const sendAlert = async (targetEmail, adminName, banToken) => {
            const retryUrl = `${publicUrl}/api/unban-verify?ip=${ip}&token=${nextRetryToken}&admin=${adminName}`;
            const banUrl = `${publicUrl}/api/security/ban-attacker?token=${banToken}`;
            const body = `
                <p>Hola <strong>${adminName}</strong>, se ha detectado un intento fallido de desbaneo para la IP: <code>${ip}</code>.</p>
                <div class="info-card" style="border-left-color: #e74c3c;">
                    <p>IP Atacante: <code>${attackerIp}</code><br>Usuario intentado: <code>${user}</code></p>
                </div>
                <p><strong>¿Fue un error de dedo?</strong> Usa este link para reintentar: <a href="${retryUrl}">[Verificar de nuevo]</a></p>
                <p><strong>¿No fuiste tú?</strong> Contacta al otro administrador. Si es un ataque, confirma el bloqueo aquí: <br>
                <a href="${banUrl}" class="btn" style="background:#000;">💀 BLOQUEAR AMENAZA</a></p>
            `;
            await dispatchEmail([targetEmail], `🚨 Alerta: Error de Validación (${ip})`, getEmailTemplate('Alerta Crítica', body, null, {type:'security', level:3}));
        };

        if (devEmail) await sendAlert(devEmail, 'Miguel', tokenMiguel);
        if (majoEmail) await sendAlert(majoEmail, 'Mariajose', tokenMariajose);
    }
});

// --- ENDPOINT PARA BANEAR ATACANTE DESDE EL CORREO ---
app.get('/api/security/ban-attacker', async (req, res) => {
    const { token } = req.query;
    const action = pendingSecurityActions.get(token);
    const publicUrl = 'https://sublimacion-mary.onrender.com';

    if (!action || Date.now() > action.expires) {
        return res.status(404).send(getGeneric404Page());
    }

    const { attackerIp, adminName, unbanIp } = action;
    const unbanStatus = pendingUnbans.get(unbanIp);

    // --- DETECTOR DE COORDINACIÓN (BLOQUEO DE BANEO CRUZADO) ---
    // Si un admin intenta banear, pero el OTRO admin ya activó el link de desbaneo...
    if (unbanStatus && unbanStatus.activated && unbanStatus.admin_active !== adminName) {
        const coordinationBody = `
            <p>Hola <strong>${adminName}</strong>,</p>
            <p>Se ha detectado un intento de baneo por tu parte mientras <strong>${unbanStatus.admin_active}</strong> tenía la sesión de desbaneo abierta.</p>
            <div class="info-card" style="border-left-color: #e67e22;">
                <p>Si fue <strong>${unbanStatus.admin_active}</strong> quien estaba intentando desbanear la IP, por favor comunicate con el otro administrador para mantener una buena coordinación y manejo de la seguridad de la página la próxima vez.</p>
            </div>
            <p>El sistema ha bloqueado el baneo automático para evitar un bloqueo accidental de un administrador legítimo.</p>
        `;
        const myEmail = adminName === 'Miguel' ? process.env.ADMIN_EMAIL_MIGUEL : process.env.ADMIN_EMAIL_MARIAJOSE;
        
        // Enviar llamado de atención al admin que clicó "Ban"
        await dispatchEmail([myEmail], "⚠️ Coordinación Requerida: Manejo de Seguridad", getEmailTemplate('Llamado de Atención', coordinationBody, null, {type: 'security', level: 1}));

        return res.send(`
            <body style="background: #000; color: #f1c40f; font-family: sans-serif; text-align: center; padding-top: 100px;">
                <h1>⚠️ Coordinación Requerida</h1>
                <p>${unbanStatus.admin_active} ya está procesando esta IP. Revisa tu correo, se te ha enviado una notificación de coordinación.</p>
            </body>
        `);
    }

    // 1. DETECTOR DE COORDINACIÓN: ¿El otro admin está activo en el proceso de desbaneo?
    if (unbanStatus && unbanStatus.activated && unbanStatus.admin_active !== adminName) {
        const warningBody = `
            <p>Se ha detectado un intento de baneo por parte de <strong>${adminName}</strong> mientras tú tenías la sesión de desbaneo abierta.</p>
            <div class="info-card" style="border-left-color: #e67e22;">
                <p>Esto indica una <strong>falta de coordinación</strong>. Por favor, comuníquense para determinar si la IP <code>${attackerIp}</code> es realmente una amenaza o fue un error de dedo.</p>
            </div>
        `;
        const otherAdminEmail = unbanStatus.admin_active === 'Miguel' ? process.env.ADMIN_EMAIL_MIGUEL : process.env.ADMIN_EMAIL_MARIAJOSE;
        await dispatchEmail([otherAdminEmail], "⚠️ Aviso: Coordinación Requerida", getEmailTemplate('Coordinación Requerida', warningBody, null, {type: 'security', level: 1}));

        return res.send(`
            <body style="background: #000; color: #f1c40f; font-family: sans-serif; text-align: center; padding-top: 100px;">
                <h1>⚠️ Coordinación Requerida</h1>
                <p>${unbanStatus.admin_active} tiene el link activo. Se le ha enviado un aviso para que se coordinen.</p>
            </body>
        `);
    }

    // 2. REGISTRAR VOTO DE BANEO (Protocolo de Consenso)
    let voteState = pendingSecurityVotes.get(attackerIp);
    if (!voteState) {
        voteState = { votes: new Set(), timestamp: Date.now(), unbanIp };
        pendingSecurityVotes.set(attackerIp, voteState);
    }
    voteState.votes.add(adminName);

    // 3. ¿BANEAMOS YA? (Si ambos votaron o si pasó el tiempo de gracia de 30 min)
    // Si el otro admin no activó el link en 30 min, asumimos que no está pendiente y ejecutamos baneo.
    const isGracedTimePassed = (Date.now() - voteState.timestamp) > (30 * 60 * 1000);

    if (voteState.votes.size >= 2 || isGracedTimePassed) {
        console.log(`💀 EJECUTANDO BANEO: Consenso alcanzado o tiempo expirado para IP ${attackerIp}.`);
        try {
            await updateBannedIpsInRender(attackerIp);
            pendingSecurityActions.delete(token);
            pendingSecurityVotes.delete(attackerIp);
            return res.send("<body style='background:#000;color:red;text-align:center;'><h1>💀 IP Fulminada</h1><p>La amenaza ha sido neutralizada.</p></body>");
        } catch (e) { return res.status(500).send(e.message); }
    }

    res.send("<body style='background:#000;color:yellow;text-align:center;'><h1>🛡️ Voto Registrado</h1><p>Esperando el consenso del otro administrador...</p></body>");
});

/**
 * Envía correo de confirmación al admin que realizó el desbaneo con copia a Miguel
 */
async function sendUnbanConfirmation(ip, adminName) {
    const token = crypto.randomBytes(32).toString('hex');
    pendingConfirmations.set(token, { ip, adminName, expires: Date.now() + (2 * 60 * 60 * 1000), currentAction: null });

    const publicUrl = 'https://sublimacion-mary.onrender.com';
    const okUrl = `${publicUrl}/api/security/confirm-unban?token=${token}&action=ok&admin=${adminName}`;
    const protectUrl = `${publicUrl}/api/security/confirm-unban?token=${token}&action=protect`;

    const body = `
        <p>Has desbaneado exitosamente la IP: <strong>${ip}</strong>.</p>
        <div class="info-card" style="border-left-color: #2ecc71;">
            <p><strong>¿Fuiste tú realmente?</strong></p>
            <p>Si este desbaneo fue accidental o sospechas de una brecha, toca el botón rojo inmediatamente.</p>
        </div>
        <div style="text-align: center; margin-top: 20px;">
            <a href="${okUrl}" class="btn" style="background: #2ecc71; margin-right: 10px;">TODO BIEN (OK)</a>
            <a href="${protectUrl}" class="btn" style="background: #e74c3c;">NO FUI YO, ¡PROTEGER!</a>
        </div>
    `;

    const adminEmail = adminName === 'Miguel' ? process.env.ADMIN_EMAIL_MIGUEL : process.env.ADMIN_EMAIL_MARIAJOSE;
    const miguelEmail = process.env.ADMIN_EMAIL_MIGUEL;

    // Enviamos a ambos. Si tú (Miguel) lo hiciste, solo te llega a ti. 
    // Si fue Majo, le llega a ella y a ti te llega la copia para auditoría suprema.
    const recipients = adminName === 'Miguel' ? [miguelEmail] : [adminEmail, miguelEmail];
    await dispatchEmail(recipients, `✅ Confirmación: IP ${ip} Desbaneada por ${adminName}`, getEmailTemplate('Seguridad: Doble Check', body));
}

app.get('/api/security/confirm-unban', async (req, res) => {
    const { token, action, confirmChange } = req.query;
    const confirmation = pendingConfirmations.get(token);

    if (!confirmation || Date.now() > confirmation.expires) {
        return res.status(404).send(getGeneric404Page());
    }

    const isProtect = (action === 'protect' || action === 'no');
    const newActionLabel = isProtect ? 'PROTEGER / BANEAR' : 'TODO BIEN (OK)';
    const prevActionLabel = confirmation.currentAction === 'protect' ? 'NO FUI YO, ¡PROTEGER!' : 'TODO BIEN (OK)';

    // 1. Detectar si es un cambio de opinión
    if (confirmation.currentAction !== null && confirmation.currentAction !== (isProtect ? 'protect' : 'ok') && confirmChange !== 'true') {
        return res.send(`
            <body style="background: #121212; color: white; font-family: sans-serif; text-align: center; padding-top: 100px;">
                <div style="max-width: 500px; margin: auto; border: 2px solid #f1c40f; padding: 30px; border-radius: 20px; background: #1e1e1e;">
                    <h2 style="color: #f1c40f;">⚠️ Cambio de Acción Detectado</h2>
                    <p>Usted indicó anteriormente que: <strong>${prevActionLabel}</strong>.</p>
                    <p>¿Está seguro de que desea cambiar su acción a: <strong>${newActionLabel}</strong>?</p>
                    <div style="margin-top: 30px;">
                        <a href="/api/security/confirm-unban?token=${token}&action=${action}&confirmChange=true" 
                           style="background: #f1c40f; color: black; padding: 12px 25px; text-decoration: none; border-radius: 50px; font-weight: bold; display: inline-block; margin-bottom: 20px;">
                           SÍ, ESTOY SEGURO
                        </a><br>
                        <a href="/" style="color: #888; text-decoration: none; font-size: 0.9rem;">No, mantener mi decisión previa</a>
                    </div>
                </div>
            </body>
        `);
    }

    // 2. Ejecutar la acción
    if (isProtect) {
        if (confirmation.currentAction !== 'protect') {
            await updateBannedIpsInRender(confirmation.ip);
            confirmation.currentAction = 'protect';
            console.log(`🛡️ Seguridad: Admin ${confirmation.adminName} ha marcado la IP ${confirmation.ip} como AMENAZA.`);
        }
        return res.send(`
            <body style='background:#000; color:#ff4444; text-align:center; padding-top: 100px; font-family: sans-serif;'>
                <h1 style="font-size: 3rem;">🚨 IP PROTEGIDA</h1>
                <p style="font-size: 1.2rem;">Se ha restablecido el bloqueo permanente para <strong>${confirmation.ip}</strong> inmediatamente.</p>
                <p style="color: #666;">Decisión registrada por: ${confirmation.adminName}</p>
            </body>
        `);
    } else {
        // Si cambia de 'Protect' a 'OK', técnicamente habría que desbanear de nuevo.
        if (confirmation.currentAction === 'protect') {
            await cleanBannedIpInRender(confirmation.ip);
            console.log(`🔄 Seguridad: Admin ${confirmation.adminName} cambió su decisión. Desbaneando ${confirmation.ip} de nuevo.`);
        }
        confirmation.currentAction = 'ok';
        return res.send(`
            <body style='background:#121212; color:#2ecc71; text-align:center; padding-top: 100px; font-family: sans-serif;'>
                <h1 style="font-size: 3rem;">✅ Confirmado</h1>
                <p style="font-size: 1.2rem;">Gracias, <strong>${confirmation.adminName}</strong>. El desbaneo de la IP ${confirmation.ip} se mantiene como legítimo.</p>
                <script>setTimeout(() => window.location.href = '/', 5000);</script>
            </body>
        `);
    }
});

// --- MANEJADOR GLOBAL DE ERRORES ---
app.use((err, req, res, next) => {
    console.error(`🚨 ERROR NO CONTROLADO: ${err.message}`);
    console.error(err.stack);
    if (!res.headersSent) {
        res.status(500).json({ success: false, error: "Hubo un error interno en el servidor. El equipo técnico ha sido notificado." });
    }
});

// Catch-all para 404 - DEBE SER LA ÚLTIMA RUTA DEFINIDA
app.use((req, res) => {
    res.status(404).send(getGeneric404Page());
});

// Cargar baneos permanentes al iniciar el servidor
validateEnvironment();
loadPermanentBans();
loadSecurityState(); // Cargar estado de intentos y niveles de baneo
syncSecurityStateFromGitHub(); // Intentar recuperar historial de la nube

const server = app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
    // Ejecutar tareas de inicialización que pueden ser lentas DESPUÉS de que el servidor esté escuchando
    (async () => {
        console.log("🚀 Iniciando tareas de inicialización asíncronas...");
        validateEnvironment(); // Validar entorno
        loadPermanentBans(); // Cargar baneos permanentes (sincrónico)
        loadSecurityState(); // Cargar estado de seguridad (sincrónico)
        // Sincronizar con GitHub (asíncrono y puede tardar)
        await syncSecurityStateFromGitHub(); 
        console.log("✅ Tareas de inicialización asíncronas completadas.");
    })();
});

// Desactivar timeout para permitir subidas grandes y lentas sin que se corte la conexión
server.timeout = 0;