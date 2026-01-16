const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer'); // Necesario para subir archivos
const imageSizeLib = require('image-size'); // Para validar dimensiones
// Fix: Asegurar que sizeOf sea una función (compatibilidad con diferentes versiones de la librería)
const sizeOf = typeof imageSizeLib === 'function' ? imageSizeLib : imageSizeLib.imageSize;
const { Octokit } = require("@octokit/rest"); // Cliente de GitHub
require('dotenv').config();

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

// Servir archivos estáticos (HTML, CSS, JS, Imágenes)
app.use(express.static(path.join(__dirname, '.')));

// Mapa de usuarios admin (Los nombres son públicos, las claves vienen del .env)
const admins = {
    'mary': process.env.ADMIN_PASS_MARY,
    'maoazaking': process.env.ADMIN_PASS_MAOAZAKING
};

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

    const isAdmin = admins.hasOwnProperty(username.toLowerCase());
    res.json({ isAdmin });
});

// Endpoint para hacer login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const userKey = username.toLowerCase();

    if (admins[userKey] && admins[userKey] === password) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
    }
});

// Endpoint para guardar un nuevo pedido con archivos
app.post('/api/pedidos', upload.fields([{ name: 'imagen', maxCount: 1 }, { name: 'plantilla', maxCount: 1 }]), async (req, res) => {
    const { producto, telefono, fecha, estado } = req.body;
    const files = req.files;

    if (!files || !files.imagen || !files.plantilla) {
        return res.status(400).json({ success: false, error: 'Faltan archivos' });
    }

    // Validar dimensiones exactas de la imagen (Lámina)
    try {
        const dimensions = sizeOf(files.imagen[0].path);
        
        // Flexibilidad: Permitir un margen de error (ej. +/- 50 pixeles)
        const targetW = 2304;
        const targetH = 934;
        const tolerance = 50;

        if (Math.abs(dimensions.width - targetW) > tolerance || Math.abs(dimensions.height - targetH) > tolerance) {
            // Si no cumple, borramos los archivos temporales y devolvemos error
            fs.unlinkSync(files.imagen[0].path);
            fs.unlinkSync(files.plantilla[0].path);
            return res.status(400).json({ success: false, error: `Dimensiones incorrectas. Se espera aprox ${targetW}x${targetH} px (±${tolerance}px). Recibido: ${dimensions.width}x${dimensions.height} px` });
        }
    } catch (err) {
        console.error("Error validando dimensiones:", err);
        // Limpiar archivos en caso de error de lectura para no dejar basura
        try { fs.unlinkSync(files.imagen[0].path); } catch(e){}
        try { fs.unlinkSync(files.plantilla[0].path); } catch(e){}
        return res.status(400).json({ success: false, error: 'El archivo de imagen no es válido o está dañado: ' + err.message });
    }

    // 1. Determinar tipo de producto y carpetas
    let tipoProducto = 'otros';
    if (producto.toLowerCase().includes('mug')) tipoProducto = 'mug';
    if (producto.toLowerCase().includes('camisa')) tipoProducto = 'camisa';

    // --- MODO GITHUB ESTRICTO ---
    // Validar que existan todas las credenciales necesarias
    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) {
        const missing = [];
        if (!githubClient) missing.push('GITHUB_TOKEN');
        if (!GITHUB_OWNER) missing.push('GITHUB_OWNER');
        if (!GITHUB_REPO) missing.push('GITHUB_REPO');

        console.error(`Error: Faltan credenciales de GitHub (${missing.join(', ')}).`);
        return res.status(500).json({ success: false, error: `El servidor no tiene configuradas las credenciales de GitHub: ${missing.join(', ')}. No se puede guardar el pedido en la nube.` });
    }

    // Si hay credenciales, procedemos a guardar DIRECTAMENTE en GitHub
        try {
            console.log("Procesando pedido vía GitHub API...");
            
            // A. Leer archivos del disco temporal a memoria
            const imagenBuffer = fs.readFileSync(files.imagen[0].path);
            const plantillaBuffer = fs.readFileSync(files.plantilla[0].path);
            const imagenExt = path.extname(files.imagen[0].originalname);
            const plantillaExt = path.extname(files.plantilla[0].originalname);

            // B. Calcular siguiente ID mirando la carpeta en GitHub
            let nextNum = 1;
            try {
                const { data: folderContent } = await githubClient.repos.getContent({
                    owner: GITHUB_OWNER,
                    repo: GITHUB_REPO,
                    path: `img/${tipoProducto}`
                });
                
                // Filtrar carpetas que sigan el patrón "producto-XX"
                let maxNum = 0;
                if (Array.isArray(folderContent)) {
                    folderContent.forEach(item => {
                        if (item.type === 'dir' && item.name.startsWith(`${tipoProducto}-`)) {
                            const num = parseInt(item.name.split('-')[1]);
                            if (!isNaN(num) && num > maxNum) maxNum = num;
                        }
                    });
                }
                nextNum = maxNum + 1;
            } catch (err) {
                // Si la carpeta no existe (404), empezamos en 1
                console.log("Carpeta no existe o error leyendo, iniciando en 1");
            }

            const folderName = `${tipoProducto}-${nextNum}`;
            const imagenName = `lamina-${tipoProducto}-${nextNum}${imagenExt}`;
            const plantillaName = `plantilla-${tipoProducto}-${nextNum}${plantillaExt}`;

            // C. Subir Imagen (Lámina)
            await githubClient.repos.createOrUpdateFileContents({
                owner: GITHUB_OWNER, repo: GITHUB_REPO,
                path: `img/${tipoProducto}/${folderName}/${imagenName}`,
                message: `Add order image ${folderName} [skip render]`, // [skip render] evita reinicio del server pero actualiza la web
                content: imagenBuffer.toString('base64')
            });

            // D. Subir Plantilla
            await githubClient.repos.createOrUpdateFileContents({
                owner: GITHUB_OWNER, repo: GITHUB_REPO,
                path: `img/${tipoProducto}/${folderName}/${plantillaName}`,
                message: `Add order template ${folderName} [skip render]`,
                content: plantillaBuffer.toString('base64')
            });

            // E. Actualizar pedidos.json (de forma robusta)
            let pedidos = [];
            let jsonFileSha = undefined;

            try {
                // 1. Intentar obtener el archivo actual (necesitamos el SHA para actualizar)
                const { data: jsonFile } = await githubClient.repos.getContent({
                    owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json'
                });
                const currentContent = Buffer.from(jsonFile.content, 'base64').toString('utf-8');
                pedidos = JSON.parse(currentContent);
                jsonFileSha = jsonFile.sha; // Guardar el SHA para la actualización
            } catch (error) {
                if (error.status === 404) {
                    console.log('pedidos.json no encontrado, se creará uno nuevo.');
                    // El archivo no existe, 'pedidos' ya es un array vacío y 'jsonFileSha' es undefined.
                } else {
                    // Si es otro error (ej. de autenticación), lo lanzamos para que lo capture el catch principal.
                    throw error;
                }
            }

            // 2. Agregar nuevo pedido
            const nuevoPedido = { telefono, producto, fecha, estado, imagen_url: `img/${tipoProducto}/${folderName}/${imagenName}` };
            pedidos.push(nuevoPedido);

            // 3. Guardar cambios (crear o actualizar)
            await githubClient.repos.createOrUpdateFileContents({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json',
                message: `Update pedidos.json for ${folderName} [skip render]`,
                content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'),
                sha: jsonFileSha // Si es undefined, crea el archivo. Si tiene valor, lo actualiza.
            });

            // Limpiar temporales
            fs.unlinkSync(files.imagen[0].path);
            fs.unlinkSync(files.plantilla[0].path);

            return res.json({ success: true, pedido: nuevoPedido });

        } catch (error) {
            console.error("Error GitHub API:", error);
            return res.status(500).json({ success: false, error: 'Error guardando en repositorio remoto: ' + error.message });
        }
});

// Endpoint para actualizar el estado de un pedido
app.post('/api/update-status', (req, res) => {
    const { imagen_url, nuevo_estado } = req.body;
    const filePath = path.join(__dirname, 'pedidos.json');

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ success: false, error: 'Error leyendo archivo' });
        
        let pedidos = [];
        try {
            pedidos = JSON.parse(data);
        } catch (e) {
            return res.status(500).json({ success: false, error: 'Error parseando JSON' });
        }

        let modificado = false;
        pedidos = pedidos.map(p => {
            if (p.imagen_url === imagen_url) {
                p.estado = nuevo_estado;
                modificado = true;
            }
            return p;
        });

        if (modificado) {
            fs.writeFile(filePath, JSON.stringify(pedidos, null, 4), (writeErr) => {
                if (writeErr) return res.status(500).json({ success: false, error: 'Error escribiendo archivo' });
                res.json({ success: true });
            });
        } else {
            res.json({ success: false, message: 'Pedido no encontrado' });
        }
    });
});

const server = app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

// Desactivar timeout para permitir subidas grandes y lentas sin que se corte la conexión
server.timeout = 0;
