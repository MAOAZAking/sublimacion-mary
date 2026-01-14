const express = require('express');
const path = require('path');
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

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
