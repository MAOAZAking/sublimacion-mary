import os
import json
from PIL import Image

def load_valid_images():
    valid_images = set()
    try:
        # Asumiendo que se ejecuta desde la raiz del proyecto
        json_path = os.path.join("json", "pedidos.json")
        if not os.path.exists(json_path):
            print("Warning: pedidos.json not found. Skipping validation.")
            return None
            
        with open(json_path, 'r', encoding='utf-8') as f:
            pedidos = json.load(f)
            
        for p in pedidos:
            # Extraer nombres de archivo de las URLs (mismo criterio que generate_word.py)
            if "imagen_url" in p and p["imagen_url"]:
                valid_images.add(os.path.basename(p["imagen_url"]))
            
            if "imagenes" in p and p["imagenes"]:
                imgs = p["imagenes"]
                if isinstance(imgs, dict):
                    if "frontal" in imgs and imgs["frontal"]: valid_images.add(os.path.basename(imgs["frontal"]))
                    if "espaldar" in imgs and imgs["espaldar"]: valid_images.add(os.path.basename(imgs["espaldar"]))
                    if "lamina" in imgs and imgs["lamina"]: valid_images.add(os.path.basename(imgs["lamina"]))
            
            if "foto_diseno_url" in p and p["foto_diseno_url"]:
                valid_images.add(os.path.basename(p["foto_diseno_url"]))
                    
    except Exception as e:
        print(f"Advertencia: No se pudo cargar pedidos.json para filtrar imagenes: {e}")
        return None
    return valid_images

def convert_images_recursive(root_directory):
    """
    Recorre recursivamente buscando:
    1. Archivos '_preview.png' o '_preview.jpeg' -> Los convierte a .jpg y borra el original.
    2. Archivos originales sin preview -> Crea un '_preview.jpg' de respaldo.
    3. LIMPIEZA: Elimina '_preview.jpg' si la imagen original ya no está en pedidos.json (fue reemplazada).
    """
    valid_images = load_valid_images()

    for dirpath, dirnames, filenames in os.walk(root_directory):
        for filename in filenames:
            lower_name = filename.lower()
            
            # --- 1. LIMPIEZA DE PREVIEWS HUÉRFANOS ---
            if '_preview' in lower_name and valid_images is not None:
                # Intentar deducir el nombre base (ej: "foto_mug_3_preview.jpg" -> "foto_mug_3")
                base_name = filename.split('_preview')[0]
                
                # Verificar si alguna imagen válida comienza con este nombre base (ej: "foto_mug_3.png")
                is_valid = False
                for valid_img in valid_images:
                    if valid_img.startswith(base_name + '.'):
                        is_valid = True
                        break
                
                if not is_valid:
                    print(f"Deleting orphaned preview: {filename}")
                    try:
                        os.remove(os.path.join(dirpath, filename))
                    except Exception as e:
                        print(f"Error deleting {filename}: {e}")
                    continue # Si se borró, saltar al siguiente archivo

            # --- 2. CONVERSIÓN DE PREVIEWS (PNG/JPEG -> JPG) ---
            # Ejemplo: lamina_preview.png -> lamina_preview.jpg (y borrar el png)
            if '_preview.' in lower_name and (lower_name.endswith('.png') or lower_name.endswith('.jpeg')):
                full_path = os.path.join(dirpath, filename)
                jpg_name = os.path.splitext(filename)[0] + ".jpg"
                jpg_path = os.path.join(dirpath, jpg_name)
                
                try:
                    with Image.open(full_path) as img:
                        if img.mode in ('RGBA', 'P'):
                            img = img.convert('RGB')
                        img.save(jpg_path, 'JPEG', quality=85)
                        print(f"Converted PREVIEW {filename} to {jpg_name}")
                    
                    # Eliminar el archivo intermedio para ahorrar espacio y evitar duplicados
                    os.remove(full_path)
                    print(f"Deleted source preview file: {filename}")
                except Exception as e:
                    print(f"Error processing preview {filename}: {e}")

            # --- 3. GENERACIÓN DE PREVIEWS FALTANTES ---
            elif (lower_name.endswith('.png') or lower_name.endswith('.jpeg') or lower_name.endswith('.jpg')) and '_preview' not in lower_name:
                
                # Solo generar preview si la imagen es válida (está en pedidos.json)
                if valid_images is not None and filename not in valid_images:
                    continue

                original_path = os.path.join(dirpath, filename)
                base_name = os.path.splitext(filename)[0]
                jpg_filename = f"{base_name}_preview.jpg"
                jpg_path = os.path.join(dirpath, jpg_filename)

                # Only convert if the JPG preview doesn't exist or is older than the PNG
                if not os.path.exists(jpg_path) or os.path.getmtime(original_path) > os.path.getmtime(jpg_path):
                    try:
                        with Image.open(original_path) as img:
                            if img.mode in ('RGBA', 'P'):
                                img = img.convert('RGB')
                            img.save(jpg_path, 'JPEG', quality=85) # Ajusta la calidad si es necesario (0-100)
                            print(f"Created fallback preview for {filename}")
                    except Exception as e:
                        print(f"Error converting {filename} in {dirpath}: {e}")

if __name__ == "__main__":
    if len(os.sys.argv) > 1:
        target_directory = os.sys.argv[1]
        if os.path.isdir(target_directory):
            print(f"Starting recursive conversion in: {target_directory}")
            convert_images_recursive(target_directory)
        else:
            print(f"Error: {target_directory} is not a valid directory.")
    else:
        print("Usage: python convert_png_to_jpg.py <root_directory_path>")