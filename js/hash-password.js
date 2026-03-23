const bcrypt = require('bcrypt');

const password = process.argv[2];

if (!password) {
    console.error("❌ Por favor, proporciona una contraseña como argumento.");
    console.log("Uso: node js/hash-password.js <tu_contraseña>");
    process.exit(1);
}

const saltRounds = 10;

bcrypt.hash(password, saltRounds, (err, hash) => {
    if (err) {
        console.error("Error al hashear:", err);
        return;
    }
    console.log(`\n🔑 Contraseña: ${password}`);
    console.log(`🔒 Hash: ${hash}\n`);
});