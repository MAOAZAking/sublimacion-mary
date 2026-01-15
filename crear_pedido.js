// Este script genera el JSON para un nuevo pedido con el formato solicitado.
// Uso en terminal: node crear_pedido.js "3001234567" "Mug Personalizado" "https://url-imagen.com"

// 1. Obtener argumentos de la línea de comandos o usar valores por defecto (###)
const args = process.argv.slice(2);
const telefono = args[0] || "###";
const producto = args[1] || "###";
const imagen_url = args[2] || "###";

// 2. Generar la fecha actual con hora (DD/MM/YYYY HH:mm:ss)
const now = new Date();
const dia = String(now.getDate()).padStart(2, '0');
const mes = String(now.getMonth() + 1).padStart(2, '0');
const anio = now.getFullYear();
const hora = String(now.getHours()).padStart(2, '0');
const min = String(now.getMinutes()).padStart(2, '0');
const seg = String(now.getSeconds()).padStart(2, '0');

const fechaCompleta = `${dia}/${mes}/${anio} ${hora}:${min}:${seg}`;

// Determinar estado según producto
let estado = "Revisión del cliente";

// 3. Crear el objeto pedido con el orden y campos específicos
const nuevoPedido = {
    "telefono": telefono,
    "producto": producto,
    "fecha": fechaCompleta,
    "estado": estado,
    "imagen_url": imagen_url
};

// 4. Imprimir el resultado en formato JSON (con comillas y estructura correcta)
console.log(JSON.stringify(nuevoPedido, null, 4));