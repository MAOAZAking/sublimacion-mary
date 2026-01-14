<?php
// Configuración básica
$envFile = __DIR__ . '/.env';
$mensaje = '';
$tipoMensaje = ''; // 'success' o 'error'

// Lógica de procesamiento del formulario
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // 1. Recoger y validar datos
    $producto = $_POST['producto'] ?? '';
    $telefono = $_POST['telefono'] ?? '';
    $archivo = $_FILES['imagen'] ?? null;

    if (empty($producto) || empty($telefono) || empty($archivo) || $archivo['error'] !== UPLOAD_ERR_OK) {
        $mensaje = "Error: Todos los campos son obligatorios y se debe subir una imagen válida.";
        $tipoMensaje = 'error';
    } elseif (!in_array($producto, ['mug', 'camisa'])) {
        $mensaje = "Error: Tipo de producto no válido.";
        $tipoMensaje = 'error';
    } else {
        // 2. Validar extensión de imagen
        $ext = strtolower(pathinfo($archivo['name'], PATHINFO_EXTENSION));
        $allowed = ['jpg', 'jpeg', 'png'];
        
        if (!in_array($ext, $allowed)) {
            $mensaje = "Error: Solo se permiten archivos JPG, JPEG y PNG.";
            $tipoMensaje = 'error';
        } else {
            // 3. Crear estructura de carpetas
            // Estructura: carpeta_producto/img-carpeta_producto/
            $baseDir = __DIR__ . '/' . $producto;
            $targetDir = $baseDir . '/img-' . $producto;

            if (!is_dir($targetDir)) {
                // Crear carpetas recursivamente (0777 para permisos en local)
                if (!mkdir($targetDir, 0777, true)) {
                    $mensaje = "Error al crear los directorios.";
                    $tipoMensaje = 'error';
                    // Detener ejecución si falla
                    goto end; 
                }
            }

            // 4. Generar nombre del archivo (Consecutivo)
            // Contamos cuántos archivos hay que empiecen con el patrón para determinar el número
            $files = glob($targetDir . "/plantilla-" . $producto . "-imagen-*." . $ext);
            // Nota: glob cuenta archivos con esa extensión específica. Para ser más preciso con el consecutivo global:
            $allFiles = glob($targetDir . "/plantilla-" . $producto . "-imagen-*");
            $consecutivo = count($allFiles) + 1;

            $nuevoNombre = "plantilla-{$producto}-imagen-{$consecutivo}.{$ext}";
            $rutaDestino = $targetDir . '/' . $nuevoNombre;
            
            // Ruta relativa para guardar en el .env (para que sea accesible luego)
            $rutaRelativa = "{$producto}/img-{$producto}/{$nuevoNombre}";

            // 5. Mover el archivo
            if (move_uploaded_file($archivo['tmp_name'], $rutaDestino)) {
                
                // 6. Lógica del archivo .env
                // Leemos el contenido actual
                $envContent = file_exists($envFile) ? file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : [];
                $newEnvContent = [];
                $found = false;

                foreach ($envContent as $line) {
                    // Separar clave=valor
                    $parts = explode('=', $line, 2);
                    if (count($parts) === 2) {
                        $key = trim($parts[0]);
                        $value = trim($parts[1]);

                        if ($key === $telefono) {
                            // Si el teléfono ya existe, anexamos la nueva ruta separada por coma (o punto y coma)
                            // Usaré punto y coma (;) para separar múltiples imágenes
                            $value .= ";" . $rutaRelativa;
                            $found = true;
                        }
                        $newEnvContent[] = "$key=$value";
                    } else {
                        // Mantener líneas que no cumplan formato (comentarios, etc)
                        $newEnvContent[] = $line;
                    }
                }

                // Si no se encontró el teléfono, agregamos nueva línea
                if (!$found) {
                    $newEnvContent[] = "$telefono=$rutaRelativa";
                }

                // Guardar cambios en .env
                file_put_contents($envFile, implode(PHP_EOL, $newEnvContent) . PHP_EOL);

                $mensaje = "¡Formulario enviado con éxito! Imagen guardada como: $nuevoNombre";
                $tipoMensaje = 'success';

            } else {
                $mensaje = "Error al mover la imagen al directorio de destino.";
                $tipoMensaje = 'error';
            }
        }
    }
    end:;
}
?>

<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Formulario de Pedido</title>
    <style>
        body { font-family: Arial, sans-serif; background-color: #f4f4f9; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .container { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
        h2 { text-align: center; color: #333; }
        .form-group { margin-bottom: 1rem; }
        label { display: block; margin-bottom: 0.5rem; color: #666; }
        input[type="text"], input[type="tel"], select, input[type="file"] { width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
        button { width: 100%; padding: 0.75rem; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 1rem; }
        button:hover { background-color: #0056b3; }
        .alert { padding: 10px; margin-bottom: 15px; border-radius: 4px; text-align: center; }
        .alert.error { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .alert.success { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
    </style>
</head>
<body>

<div class="container">
    <h2>Subir Diseño</h2>

    <?php if (!empty($mensaje)): ?>
        <div class="alert <?php echo $tipoMensaje; ?>">
            <?php echo $mensaje; ?>
        </div>
    <?php endif; ?>

    <form action="" method="POST" enctype="multipart/form-data">
        <div class="form-group">
            <label for="producto">Tipo de Producto:</label>
            <select name="producto" id="producto" required>
                <option value="" disabled selected>Seleccione una opción</option>
                <option value="mug">Mug</option>
                <option value="camisa">Camisa</option>
            </select>
        </div>

        <div class="form-group">
            <label for="imagen">Subir Imagen (JPG, JPEG, PNG):</label>
            <input type="file" name="imagen" id="imagen" accept=".jpg, .jpeg, .png" required>
        </div>

        <div class="form-group">
            <label for="telefono">Número Celular (Credencial):</label>
            <input type="tel" name="telefono" id="telefono" placeholder="Ej: 3001234567" required pattern="[0-9]+">
        </div>

        <button type="submit">Enviar</button>
    </form>
</div>

</body>
</html>
