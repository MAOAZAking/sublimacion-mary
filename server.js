const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer'); // Necesario para subir archivos
const imageSizeLib = require('image-size'); // Para validar dimensiones
// Fix: Asegurar que sizeOf sea una función (compatibilidad con diferentes versiones de la librería)
const sizeOf = typeof imageSizeLib === 'function' ? imageSizeLib : imageSizeLib.imageSize;
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
        // Si la contraseña está vacía, requiere configuración (Flujo Majo)
        if (user.password === "") {
            return res.json({ isAdmin: true, isSetupRequired: true, redirectUrl: user.redirectUrl });
        }
        return res.json({ isAdmin: true, isSetupRequired: false, email: resolveEnvValue(user.email) });
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
            return res.json({ success: true, redirectUrl: user.redirectUrl || 'bienvenida_majo.html', email: resolveEnvValue(user.email) });
        }
    }
    
    res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
});

// Endpoint para completar configuración (Usuario y Contraseña)
app.post('/api/complete-setup', (req, res) => {
    const { currentUsername, newUsername, newPassword, newEmail } = req.body;
    
    // Usuarios antiguos a los que se les actualizará el email (sin eliminarlos)
    const usersToUpdate = ['mary', '3209287029'];

    // Actualizar email de usuarios antiguos
    users.forEach(u => {
        if (usersToUpdate.includes(u.username)) {
            u.email = newEmail;
        }
    });

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
        redirectUrl: 'admin_dashboard.html'
    });

    // Asegurar que el desarrollador (MAOAZAking) esté registrado con su correo principal
    if (!users.some(u => u.username === 'MAOAZAking')) {
        users.push({
            username: 'MAOAZAking',
            password: process.env.DEV_PASSWORD || 'adminDev123', 
            email: process.env.DEV_EMAIL || 'maoaza13579@gmail.com',
            redirectUrl: 'admin_dashboard.html'
        });
    }
    
    try {
        fs.writeFileSync(path.join(__dirname, 'usuarios.json'), JSON.stringify(users, null, 4));
        res.json({ success: true });
    } catch (err) {
        console.error("Error guardando usuarios.json:", err);
        res.status(500).json({ success: false, error: 'Error guardando cambios.' });
    }
});

// Endpoint para obtener el correo del administrador (para notificaciones)
app.get('/api/get-admin-email', (req, res) => {
    // Priorizar el email que NO sea del desarrollador (para que sea el de Majo)
    const admin = users.find(u => u.email && u.username !== 'MAOAZAking');
    const email = admin ? resolveEnvValue(admin.email) : (process.env.DEFAULT_ADMIN_EMAIL || 'maoaza13579@gmail.com');
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
    const { producto, telefono, fecha, estado } = req.body;
    const files = req.files || {};

    // 1. Determinar tipo de producto
    let tipoProducto = 'otros';
    if (producto && producto.toLowerCase().includes('mug')) tipoProducto = 'mug';
    if (producto && producto.toLowerCase().includes('camiseta')) tipoProducto = 'camiseta';

    // 2. Validaciones por tipo de producto
    if (tipoProducto === 'camiseta') {
        // Validación para Camisetas
        if (!files.lamina_frontal && !files.lamina_espaldar) {
            // Limpiar plantilla si existe pero faltan láminas
            if (files.plantilla) try { fs.unlinkSync(files.plantilla[0].path); } catch(e){}
            return res.status(400).json({ success: false, error: 'Para camisetas, es obligatorio subir al menos una lámina (frontal o espaldar).' });
        }
        if (!files.plantilla) {
            // Limpiar láminas si existen pero falta plantilla
            if (files.lamina_frontal) try { fs.unlinkSync(files.lamina_frontal[0].path); } catch(e){}
            if (files.lamina_espaldar) try { fs.unlinkSync(files.lamina_espaldar[0].path); } catch(e){}
            return res.status(400).json({ success: false, error: 'Para camisetas, es obligatorio subir la plantilla (.ai).' });
        }

        const validateCamiseta = (file) => {
            const dim = sizeOf(file.path);
            // Dimensiones máximas (Aprox A4 300dpi)
            const maxW = 2482; 
            const maxH = 3510;
            const tolerance = 20; // Pequeña tolerancia

            if (dim.width > (maxW + tolerance) || dim.height > (maxH + tolerance)) {
                throw new Error(`Dimensiones excedidas. Máximo permitido aprox: ${maxW}x${maxH} px. Recibido: ${dim.width}x${dim.height} px`);
            }
        };

        try {
            if (files.lamina_frontal) validateCamiseta(files.lamina_frontal[0]);
            if (files.lamina_espaldar) validateCamiseta(files.lamina_espaldar[0]);
        } catch (err) {
            if (files.lamina_frontal) try { fs.unlinkSync(files.lamina_frontal[0].path); } catch(e){}
            if (files.lamina_espaldar) try { fs.unlinkSync(files.lamina_espaldar[0].path); } catch(e){}
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
                return res.status(400).json({ success: false, error: `Dimensiones incorrectas. Se espera aprox ${targetW}x${targetH} px (±${tolerance}px). Recibido: ${dimensions.width}x${dimensions.height} px` });
            }
        } catch (err) {
            try { fs.unlinkSync(files.imagen[0].path); } catch(e){}
            try { fs.unlinkSync(files.plantilla[0].path); } catch(e){}
            return res.status(400).json({ success: false, error: 'El archivo de imagen no es válido: ' + err.message });
        }
    }

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
            
            // 0. Obtener información del repositorio (Rama principal) para construir URLs absolutas
            const { data: repoData } = await githubClient.repos.get({ owner: GITHUB_OWNER, repo: GITHUB_REPO });
            const branch = repoData.default_branch;
            
            // A. Calcular siguiente ID mirando la carpeta en GitHub
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
            
            // B. Preparar subidas según tipo de producto
            const uploads = [];
            let mainImageUrl = '';
            let urlFrontal = null;
            let urlespaldar = null;
            let urlFotoDiseno = null;

            if (tipoProducto === 'camiseta') {
                // Subir Lámina Frontal
                if (files.lamina_frontal) {
                    const ext = path.extname(files.lamina_frontal[0].originalname);
                    const name = `lamina_frontal_${tipoProducto}_${nextNum}${ext}`;
                    const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                    uploads.push({
                        path: relativePath,
                        content: fs.readFileSync(files.lamina_frontal[0].path),
                        msg: `Add frontal image ${folderName}`
                    });
                    urlFrontal = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                    mainImageUrl = urlFrontal;
                }
                // Subir Lámina espaldar
                if (files.lamina_espaldar) {
                    const ext = path.extname(files.lamina_espaldar[0].originalname);
                    const name = `lamina_espaldar_${tipoProducto}_${nextNum}${ext}`;
                    const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                    uploads.push({
                        path: relativePath,
                        content: fs.readFileSync(files.lamina_espaldar[0].path),
                        msg: `Add espaldar image ${folderName}`
                    });
                    urlespaldar = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
                    if (!mainImageUrl) mainImageUrl = urlespaldar;
                }
                // Subir Plantilla Camiseta
                if (files.plantilla) {
                    const ext = path.extname(files.plantilla[0].originalname);
                    const name = `plantilla_${tipoProducto}_${nextNum}${ext}`;
                    uploads.push({
                        path: `img/${tipoProducto}/${folderName}/${name}`,
                        content: fs.readFileSync(files.plantilla[0].path),
                        msg: `Add template ${folderName}`
                    });
                }
            } else {
                // Mugs (Comportamiento original)
                const imagenExt = path.extname(files.imagen[0].originalname);
                const plantillaExt = path.extname(files.plantilla[0].originalname);
                const imagenName = `lamina_${tipoProducto}_${nextNum}${imagenExt}`;
                const plantillaName = `plantilla_${tipoProducto}_${nextNum}${plantillaExt}`;

                const relativeImgPath = `img/${tipoProducto}/${folderName}/${imagenName}`;
                const relativeTemplatePath = `img/${tipoProducto}/${folderName}/${plantillaName}`;

                uploads.push({
                    path: relativeImgPath,
                    content: fs.readFileSync(files.imagen[0].path),
                    msg: `Add order image ${folderName}`
                });
                uploads.push({
                    path: relativeTemplatePath,
                    content: fs.readFileSync(files.plantilla[0].path),
                    msg: `Add order template ${folderName}`
                });
                mainImageUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativeImgPath}`;
            }

            // Subir Foto Usada en Diseño (Opcional)
            if (files.foto_diseno) {
                const ext = path.extname(files.foto_diseno[0].originalname);
                const name = `foto_usada_en_${tipoProducto}_${nextNum}${ext}`;
                const relativePath = `img/${tipoProducto}/${folderName}/${name}`;
                uploads.push({
                    path: relativePath,
                    content: fs.readFileSync(files.foto_diseno[0].path),
                    msg: `Add design reference photo ${folderName}`
                });
                urlFotoDiseno = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${relativePath}`;
            }

            // C. SUBIDA ROBUSTA (Git Data API)
            // Usamos la API de bajo nivel (Blobs/Trees) para soportar archivos grandes y evitar timeouts.
            
            // 1. Subir archivos (Imágenes/Plantillas) como Blobs
            const treeItems = [];
            console.log("Iniciando subida de archivos (Blobs)...");

            for (const up of uploads) {
                console.log(`Subiendo blob: ${up.path}`);
                const { data: blobData } = await githubClient.git.createBlob({
                    owner: GITHUB_OWNER,
                    repo: GITHUB_REPO,
                    content: up.content.toString('base64'),
                    encoding: 'base64'
                });
                treeItems.push({
                    path: up.path,
                    mode: '100644',
                    type: 'blob',
                    sha: blobData.sha
                });
                await delay(500); // Pequeña pausa para estabilidad
            }

            // 2. Obtener referencia del último commit
            const { data: refData } = await githubClient.git.getRef({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                ref: `heads/${branch}`
            });
            const latestCommitSha = refData.object.sha;
            
            const { data: commitData } = await githubClient.git.getCommit({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                commit_sha: latestCommitSha
            });
            const baseTreeSha = commitData.tree.sha;

            // 3. Actualizar pedidos.json
            let pedidos = [];
            try {
                const { data: jsonFile } = await githubClient.repos.getContent({
                    owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json', ref: branch
                });
                const currentContent = Buffer.from(jsonFile.content, 'base64').toString('utf-8');
                pedidos = JSON.parse(currentContent);
            } catch (error) {
                if (error.status !== 404) console.warn("pedidos.json no encontrado, creando nuevo.");
            }

            const nuevoPedido = { 
                telefono, producto, fecha, estado, 
                imagen_url: mainImageUrl,
                imagenes: { frontal: urlFrontal, espaldar: urlespaldar },
                foto_diseno_url: urlFotoDiseno
            };
            pedidos.push(nuevoPedido);

            // Crear blob para pedidos.json
            const { data: jsonBlob } = await githubClient.git.createBlob({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'),
                encoding: 'base64'
            });
            treeItems.push({
                path: 'pedidos.json',
                mode: '100644',
                type: 'blob',
                sha: jsonBlob.sha
            });

            // 4. Crear Árbol y Commit
            console.log("Creando árbol y commit...");
            const { data: newTree } = await githubClient.git.createTree({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                base_tree: baseTreeSha,
                tree: treeItems
            });

            const { data: newCommit } = await githubClient.git.createCommit({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                message: `Nuevo pedido: ${producto} - ${folderName} [skip render]`,
                tree: newTree.sha,
                parents: [latestCommitSha]
            });

            // 5. Actualizar Referencia
            await githubClient.git.updateRef({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                ref: `heads/${branch}`,
                sha: newCommit.sha
            });

            // Limpiar temporales
            if (files.imagen) try { fs.unlinkSync(files.imagen[0].path); } catch(e){}
            if (files.plantilla) try { fs.unlinkSync(files.plantilla[0].path); } catch(e){}
            if (files.lamina_frontal) try { fs.unlinkSync(files.lamina_frontal[0].path); } catch(e){}
            if (files.lamina_espaldar) try { fs.unlinkSync(files.lamina_espaldar[0].path); } catch(e){}
            if (files.foto_diseno) try { fs.unlinkSync(files.foto_diseno[0].path); } catch(e){}

            return res.json({ success: true, pedido: nuevoPedido });

        } catch (error) {
            console.error("Error GitHub API:", error);
            return res.status(500).json({ success: false, error: 'Error guardando en repositorio remoto: ' + error.message });
        }
});

// Endpoint para actualizar el estado de un pedido
app.post('/api/update-status', async (req, res) => {
    const { imagen_url, nuevo_estado } = req.body;
    
    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) {
        return res.status(500).json({ success: false, error: 'Credenciales de GitHub no configuradas.' });
    }

    try {
        // 1. Obtener archivo actual de GitHub
        const { data: jsonFile } = await githubClient.repos.getContent({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json'
        });
        const currentContent = Buffer.from(jsonFile.content, 'base64').toString('utf-8');
        let pedidos = JSON.parse(currentContent);

        // 2. Actualizar estado
        let modificado = false;
        pedidos = pedidos.map(p => {
            if (p.imagen_url === imagen_url) {
                p.estado = nuevo_estado;
                modificado = true;
            }
            return p;
        });

        if (!modificado) return res.json({ success: false, message: 'Pedido no encontrado' });

        // 3. Guardar cambios en GitHub
        await githubClient.repos.createOrUpdateFileContents({
            owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'pedidos.json',
            message: `Update status to ${nuevo_estado} [skip render]`,
            content: Buffer.from(JSON.stringify(pedidos, null, 4)).toString('base64'),
            sha: jsonFile.sha
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Error actualizando estado:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint para descargar la carpeta del producto como ZIP
app.get('/api/download-folder/:type/:folder', async (req, res) => {
    const { type, folder } = req.params;

    if (!githubClient || !GITHUB_OWNER || !GITHUB_REPO) {
        return res.status(500).send('Credenciales de GitHub no configuradas en el servidor.');
    }

    try {
        const folderPath = `img/${type}/${folder}`;
        
        // 1. Obtener lista de archivos en la carpeta de GitHub
        const { data: dirContent } = await githubClient.repos.getContent({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: folderPath
        });

        if (!Array.isArray(dirContent)) {
            return res.status(404).send('Carpeta no encontrada.');
        }

        // 2. Configurar respuesta como archivo ZIP
        res.attachment(`${folder}.zip`);
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('error', (err) => res.status(500).send({ error: err.message }));
        archive.pipe(res);

        // 3. Descargar cada archivo y agregarlo al ZIP
        for (const item of dirContent) {
            if (item.type === 'file') {
                // Usamos getBlob para obtener el contenido completo
                const { data: blob } = await githubClient.git.getBlob({
                    owner: GITHUB_OWNER,
                    repo: GITHUB_REPO,
                    file_sha: item.sha
                });
                const buffer = Buffer.from(blob.content, 'base64');
                archive.append(buffer, { name: item.name });
            }
        }

        await archive.finalize();
    } catch (error) {
        console.error("Error descargando ZIP:", error);
        if (!res.headersSent) res.status(500).send('Error generando ZIP: ' + error.message);
    }
});

// Endpoint para obtener configuración de modelos 3D desde variables de entorno
app.get('/api/config-models', (req, res) => {
    res.json({
        hombre: process.env.MODELO_3D_HOMBRE,
        mujer: process.env.MODELO_3D_MUJER
    });
});

const server = app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

// Desactivar timeout para permitir subidas grandes y lentas sin que se corte la conexión
server.timeout = 0;
