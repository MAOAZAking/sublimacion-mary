const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer'); // Necesario para subir archivos
const sizeOf = require('image-size'); // Para validar dimensiones
const { Octokit } = require("@octokit/rest"); // Cliente de GitHub
require('dotenv').config();

const app = express();
const PORT = 3000;

// Middleware para procesar JSON
app.use(express.json({ limit: '50gb' }));
app.use(express.urlencoded({ limit: '50gb', extended: true }));

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
        if (dimensions.width !== 2304 || dimensions.height !== 934) {
            // Si no cumple, borramos los archivos temporales y devolvemos error
            fs.unlinkSync(files.imagen[0].path);
            fs.unlinkSync(files.plantilla[0].path);
            return res.status(400).json({ success: false, error: `Dimensiones incorrectas. La imagen debe ser de 2304x934 px. (Recibido: ${dimensions.width}x${dimensions.height} px)` });
        }
    } catch (err) {
        console.error("Error validando dimensiones:", err);
        return res.status(400).json({ success: false, error: 'El archivo de imagen no es válido o está dañado.' });
    }

    // 1. Determinar tipo de producto y carpetas
    let tipoProducto = 'otros';
    if (producto.toLowerCase().includes('mug')) tipoProducto = 'mug';
    if (producto.toLowerCase().includes('camisa')) tipoProducto = 'camisa';

    // --- MODO GITHUB (Para Producción en Render) ---
    if (githubClient) {
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
                message: `Add order image ${folderName} [skip ci]`, // [skip ci] evita redeploy infinito
                content: imagenBuffer.toString('base64')
            });

            // D. Subir Plantilla
            await githubClient.repos.createOrUpdateFileContents({
                owner: GITHUB_OWNER, repo: GITHUB_REPO,
                path: `img/${tipoProducto}/${folderName}/${plantillaName}`,
                message: `Add order template ${folderName} [skip ci]`,
                content: plantillaBuffer.toString('base64')
            });

            // E. Actualizar pedidos.json
            // 1. Obtener archivo actual (necesitamos el SHA para actualizar)
            const { data: jsonFile } = await githubClient.repos.getContent({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json'
            });
            const currentContent = Buffer.from(jsonFile.content, 'base64').toString('utf-8');
            const pedidos = JSON.parse(currentContent);

            // 2. Agregar nuevo pedido
            const nuevoPedido = { telefono, producto, fecha, estado, imagen_url: `img/${tipoProducto}/${folderName}/${imagenName}` };
            pedidos.push(nuevoPedido);

            // 3. Guardar cambios
            await githubClient.repos.createOrUpdateFileContents({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json',
                message: `Update pedidos.json for ${folderName} [skip ci]`,
                content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'),
                sha: jsonFile.sha
            });

            // Limpiar temporales
            fs.unlinkSync(files.imagen[0].path);
            fs.unlinkSync(files.plantilla[0].path);

            return res.json({ success: true, pedido: nuevoPedido });

        } catch (error) {
            console.error("Error GitHub API:", error);
            return res.status(500).json({ success: false, error: 'Error guardando en repositorio remoto: ' + error.message });
        }
    }

    // --- MODO LOCAL (Fallback si no hay token configurado) ---
    const baseImgDir = path.join(__dirname, 'img');
    const productDir = path.join(baseImgDir, tipoProducto);

    // Asegurar que existan las carpetas base
    if (!fs.existsSync(baseImgDir)) fs.mkdirSync(baseImgDir);
    if (!fs.existsSync(productDir)) fs.mkdirSync(productDir);

    // 2. Calcular el siguiente número de carpeta (mug-XX)
    const existingDirs = fs.readdirSync(productDir).filter(file => {
        return fs.statSync(path.join(productDir, file)).isDirectory() && file.startsWith(`${tipoProducto}-`);
    });

    let maxNum = 0;
    existingDirs.forEach(dir => {
        const num = parseInt(dir.split('-')[1]);
        if (!isNaN(num) && num > maxNum) maxNum = num;
    });
    const nextNum = maxNum + 1;
    const newFolderName = `${tipoProducto}-${nextNum}`;
    const newFolderPath = path.join(productDir, newFolderName);

    // 3. Crear la nueva carpeta
    fs.mkdirSync(newFolderPath);

    // 4. Mover y renombrar archivos
    // Plantilla (.ai) -> img/mug/mug-12/plantilla-mug-12.ai
    const plantillaExt = path.extname(files.plantilla[0].originalname);
    const plantillaName = `plantilla-${tipoProducto}-${nextNum}${plantillaExt}`;
    const plantillaPath = path.join(newFolderPath, plantillaName);
    fs.renameSync(files.plantilla[0].path, plantillaPath);

    // Lámina (Imagen) -> img/mug/lamina-mug-12.png (En la carpeta padre)
    const imagenExt = path.extname(files.imagen[0].originalname);
    const imagenName = `lamina-${tipoProducto}-${nextNum}${imagenExt}`;
    const imagenPath = path.join(productDir, imagenName);
    fs.renameSync(files.imagen[0].path, imagenPath);

    // 5. Actualizar pedidos.json
    const imagenUrlRelativa = `img/${tipoProducto}/${imagenName}`.replace(/\\/g, '/'); // Ruta relativa para web
    
    const nuevoPedido = {
        telefono,
        producto,
        fecha,
        estado,
        imagen_url: imagenUrlRelativa
    };

    const filePath = path.join(__dirname, 'pedidos.json');

    // Leer el archivo actual
    fs.readFile(filePath, 'utf8', (err, data) => {
        let pedidos = [];
        if (!err && data) {
            try {
                pedidos = JSON.parse(data);
            } catch (e) {
                console.error("Error al parsear JSON existente, se creará uno nuevo.");
            }
        }
        
        // Agregar el nuevo pedido
        pedidos.push(nuevoPedido);

        // Guardar el archivo actualizado
        fs.writeFile(filePath, JSON.stringify(pedidos, null, 4), (writeErr) => {
            if (writeErr) {
                console.error("Error escribiendo archivo:", writeErr);
                return res.status(500).json({ success: false, error: 'Error al guardar en disco' });
            }
            res.json({ success: true, pedido: nuevoPedido });
        });
    });
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
