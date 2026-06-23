#!/usr/bin/env python3
"""
DEM to 16-bit PNG Converter for Taiwan Flood Simulator.
Supports raw DEM formats (GeoTIFF, ASCII Grid, grayscale images) and encodes
elevation data into a 16-bit PNG (using Red and Green channels) with a land mask (Blue channel).

Supports two encoding modes:
1. 'direct' (Legacy): elevation in meters = R * 256 + G (1-meter vertical resolution)
2. 'normalized' (Scientific): elevation is linearly mapped from [min, max] to [0, 65535] (6.1-cm vertical resolution for 0-4000m range)
"""

import os
import sys
import argparse

def install_and_import(package):
    import importlib
    try:
        importlib.import_module(package)
    except ImportError:
        import subprocess
        print(f"Installing missing package: {package}...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", package])
        except Exception as e:
            print(f"Failed to install {package}: {e}. Falling back to standard libraries.")

# Ensure Pillow is installed
try:
    from PIL import Image
except ImportError:
    install_and_import("Pillow")
    from PIL import Image

try:
    import numpy as np
except ImportError:
    install_and_import("numpy")
    import numpy as np

# Try importing rasterio for advanced GeoTIFF reading
RASTERIO_AVAILABLE = False
try:
    import rasterio
    RASTERIO_AVAILABLE = True
except ImportError:
    print("rasterio is not installed. GeoTIFF files will be read using Pillow (which may lose geospatial metadata).")
    print("To install: pip install rasterio")

def convert_dem_to_png(input_path, output_path, mode='normalized', nodata_val=-9999, min_val=0, max_val=4000):
    print(f"Reading input file: {input_path}")
    print(f"Encoding mode: {mode} (Range: {min_val}m to {max_val}m)")
    
    ext = os.path.splitext(input_path.lower())[1]
    
    elevations = None
    nodata_mask = None
    
    # 1. Read elevation grid
    if ext in ['.tif', '.tiff'] and RASTERIO_AVAILABLE:
        print("Parsing GeoTIFF using rasterio...")
        with rasterio.open(input_path) as src:
            elevations = src.read(1)
            nodata = src.nodata if src.nodata is not None else nodata_val
            nodata_mask = (elevations == nodata) | np.isnan(elevations)
            print(f"Geospatial bounds: {src.bounds}")
            print(f"CRS: {src.crs}")
            
    elif ext in ['.asc', '.txt']:
        # ASCII Grid format
        print("Parsing ASCII Grid format (.asc)...")
        header = {}
        data_lines = []
        with open(input_path, 'r') as f:
            for _ in range(6):
                line = f.readline().strip().split()
                if len(line) == 2:
                    header[line[0].lower()] = float(line[1])
            
            ncols = int(header.get('ncols', 0))
            nrows = int(header.get('nrows', 0))
            nodata = header.get('nodata_value', nodata_val)
            
            print(f"Grid size: {ncols}x{nrows}, NoData value: {nodata}")
            
            # Read the rest of the file
            for line in f:
                data_lines.extend([float(x) for x in line.strip().split()])
                
        elevations = np.array(data_lines).reshape((nrows, ncols))
        nodata_mask = (elevations == nodata)
        
    elif ext in ['.png', '.jpg', '.jpeg', '.tif', '.tiff']:
        # Image-based DEM (grayscale or geotiff read via Pillow)
        print("Parsing Image/TIFF format using Pillow...")
        img = Image.open(input_path)
        img_gray = img.convert('F') # Convert to floating point grayscale
        elevations = np.array(img_gray)
        nodata_mask = (elevations <= nodata_val) | (elevations == 0) # Assumes 0 or below is ocean/no-data
        
    else:
        print(f"Unsupported file format: {ext}")
        sys.exit(1)
        
    # 2. Process and Encode Elevations
    if mode == 'normalized':
        # Linear normalization mapping: [min_val, max_val] -> [0, 65535]
        # Clamp elevations to valid range
        clamped = np.clip(elevations, min_val, max_val)
        # Normalize to 0.0 - 1.0
        normalized = (clamped - min_val) / (max_val - min_val)
        # Scale to 16-bit range
        scaled_ints = (normalized * 65535.0).astype(np.uint16)
    else:
        # 'direct' legacy mode (1 meter = 1 unit)
        clamped = np.clip(elevations, min_val, max_val)
        scaled_ints = clamped.astype(np.uint16)
        
    # 3. Split into R and G channels (high and low bytes of 16-bit integer)
    r_channel = (scaled_ints // 256).astype(np.uint8)
    g_channel = (scaled_ints % 256).astype(np.uint8)
    
    # 4. Create Blue channel as land mask (255 = land, 0 = ocean)
    b_channel = np.ones_like(r_channel, dtype=np.uint8) * 255
    b_channel[nodata_mask] = 0
    
    # Zero out R and G for ocean pixels
    r_channel[nodata_mask] = 0
    g_channel[nodata_mask] = 0
    
    # 5. Combine channels into RGB image
    rgb_array = np.stack([r_channel, g_channel, b_channel], axis=-1)
    output_img = Image.fromarray(rgb_array, 'RGB')
    
    # Save image
    output_img.save(output_path, 'PNG')
    print(f"Successfully converted and saved to: {output_path}")
    print(f"Image dimensions: {output_img.width}x{output_img.height}")

def main():
    parser = argparse.ArgumentParser(description="Convert raw DEM elevation data into a 16-bit PNG for the Flood Simulator.")
    parser.add_argument("-i", "--input", required=True, help="Path to raw DEM file (.asc, .tif, .png, etc.)")
    parser.add_argument("-o", "--output", required=True, help="Path to save the output PNG file")
    parser.add_argument("-m", "--mode", choices=['direct', 'normalized'], default='normalized',
                        help="Encoding mode: 'direct' for 1-meter integer vertical resolution (R*256+G), 'normalized' for 16-bit linear mapping (default: 'normalized')")
    parser.add_argument("--nodata", type=float, default=-9999, help="NoData value representing ocean in the DEM (default: -9999)")
    parser.add_argument("--min", type=int, default=0, help="Minimum elevation in meters (default: 0)")
    parser.add_argument("--max", type=int, default=4000, help="Maximum elevation in meters (default: 4000)")
    
    args = parser.parse_args()
    
    convert_dem_to_png(args.input, args.output, args.mode, args.nodata, args.min, args.max)

if __name__ == "__main__":
    main()
