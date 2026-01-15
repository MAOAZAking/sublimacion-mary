const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = 3000;

// Middleware para procesar JSON
app.use(express.json());

// Servir archivos estáticos (HTML, CSS, JS, Imágenes)
app.use(express.static(path.join(__dirname, '.')));

// Mapa de usuarios admin (Los nombres son públicos, las claves vienen del .env)
const admins = {
    'mary': process.env.ADMIN_PASS_MARY,
    'maoazaking': process.env.ADMIN_PASS_MAOAZAKING
};

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

// Endpoint para guardar un nuevo pedido en pedidos.json
app.post('/api/pedidos', (req, res) => {
    const nuevoPedido = req.body;
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
            res.json({ success: true });
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

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
