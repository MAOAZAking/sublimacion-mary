# 🎨 Sistema de Gestión - Sublimación Mary

## 🚀 Características Principales

## Forma de enviar commits
# Nota: El número de parche y numero de correción y mejora estan actualizados
*   **Gestión de Pedidos:** Creación, edición y seguimiento de estados (Mugs, Camisetas, Gorras, Sacos).
*   **Seguridad Biométrica:** Inicio de sesión facial para administradores usando `face-api.js`.
*   **Visualización 3D:** Previsualización realista de productos textiles y cerámicos con `Three.js`.
*   **Automatización:** 
    *   Generación automática de documentos Word para imprimir (Python).
    *   Conversión y optimización de imágenes (Python).
    *   Notificaciones automáticas por correo electrónico (Node.js + GitHub Actions).
*   **Integración WhatsApp:** Comunicación directa con clientes mediante enlaces inteligentes.
*   **Seguridad Robusta:** Baneos de IP inteligentes, detección de actividad sospechosa y sincronización de seguridad en la nube.


## 📂 Estructura del Proyecto

El proyecto sigue una arquitectura organizada para facilitar el mantenimiento:

*   **`/` (Raíz):** Archivos HTML principales (`index.html`, `admin_dashboard.html`, `mis_pedidos.html`) y configuración (`.env`, `package.json`).
*   **`js/`:** Lógica del servidor y scripts del cliente.
    *   `server.js`: Servidor Express principal.
    *   `worker_email.js`: Worker para envío de correos en segundo plano.
*   **`json/`:** Bases de datos ligeras.
    *   `pedidos.json`: Registro de todos los pedidos.
    *   `usuarios.json`: Credenciales y configuración de admins.
    *   `clientes.json`: CRM básico de clientes.
*   **`python/`:** Scripts de automatización y procesamiento.
    *   `generate_word.py`: Crea plantillas de impresión.
    *   `convert_to_jpg.py`: Optimización de imágenes.
*   **`img/`:** Almacenamiento de imágenes de productos (organizado por tipo y carpeta).
*   **`models_rf/`:** Modelos de IA para reconocimiento facial y registros de seguridad.

## 🛠️ Instalación y Ejecución

### Requisitos
*   Node.js v18+
*   Python 3.x (con `Pillow` y `python-docx`)

### Comandos

1.  **Instalar dependencias:**
    ```bash
    npm install
    ```

2.  **Iniciar Servidor (Producción/Local):**
    ```bash
    npm start
    # Ejecuta: node js/server.js
    ```

## 🔒 Seguridad

El sistema incluye un firewall de aplicaciones a nivel de Express para proteger archivos sensibles (`.json` de configuración, `.env`) y un sistema de baneo de IPs sincronizado con GitHub para persistencia.




## #############################################################################################
## Para ejecutar el Node.js en terminal agregar este comando
node server.js
# Para graer todos los cambios ze github y sobreescribir
git fetch --all
#
git reset --hard origin/main
Sistema integral para la gestión de pedidos de sublimación, diseñado para optimizar el flujo de trabajo desde la toma del pedido hasta la producción y entrega.

# Correccion N° del parche de seguridad N°
Security Patch #10 Fix #1:
# Mejora N° del parche de seguridad N°
Security Patch #10 Enhancement #0:
# Parche de automatización N°
Automation #8 Patch #2: