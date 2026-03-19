import os
from PIL import Image

def convert_png_to_jpg_preview_recursive(root_directory):
    """
    Recursively converts all PNG images in the specified root directory and its subdirectories
    to JPG format, saving them with a '_preview.jpg' suffix.
    """
    for dirpath, dirnames, filenames in os.walk(root_directory):
        for filename in filenames:
            if filename.lower().endswith('.png'):
                png_path = os.path.join(dirpath, filename)
                base_name = os.path.splitext(filename)[0]
                jpg_filename = f"{base_name}_preview.jpg"
                jpg_path = os.path.join(dirpath, jpg_filename)

                # Only convert if the JPG preview doesn't exist or is older than the PNG
                if not os.path.exists(jpg_path) or os.path.getmtime(png_path) > os.path.getmtime(jpg_path):
                    try:
                        with Image.open(png_path) as img:
                            if img.mode in ('RGBA', 'P'):
                                img = img.convert('RGB')
                            img.save(jpg_path, 'JPEG', quality=85) # Ajusta la calidad si es necesario (0-100)
                            print(f"Converted {filename} to {jpg_filename} in {dirpath}")
                    except Exception as e:
                        print(f"Error converting {filename} in {dirpath}: {e}")
                else:
                    print(f"Skipping {filename} in {dirpath}, {jpg_filename} is up to date.")

if __name__ == "__main__":
    if len(os.sys.argv) > 1:
        target_directory = os.sys.argv[1]
        if os.path.isdir(target_directory):
            print(f"Starting recursive conversion in: {target_directory}")
            convert_png_to_jpg_preview_recursive(target_directory)
        else:
            print(f"Error: {target_directory} is not a valid directory.")
    else:
        print("Usage: python convert_png_to_jpg.py <root_directory_path>")