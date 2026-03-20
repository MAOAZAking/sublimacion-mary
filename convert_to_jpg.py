import os
from PIL import Image

def convert_images_recursive(root_directory):
    """
    Recorre recursivamente buscando:
    1. Archivos '_preview.png' o '_preview.jpeg' -> Los convierte a .jpg y borra el original.
    2. Archivos originales sin preview -> Crea un '_preview.jpg' de respaldo.
    """
    for dirpath, dirnames, filenames in os.walk(root_directory):
        for filename in filenames:
            lower_name = filename.lower()
            
            # CASO 1: Procesar Previews que no son JPG (generados por server.js)
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

            # CASO 2: Fallback (Crear preview si no existe para archivos antiguos)
            elif (lower_name.endswith('.png') or lower_name.endswith('.jpeg')) and '_preview' not in lower_name:
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