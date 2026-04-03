/**
 * Generates circular app icons from logo.png for Electron app
 * Run with: node scripts/generate-icons.js
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Dynamic import for ESM module
let pngToIco;

const LOGO_PATH = path.join(__dirname, '..', 'logo.png');
const BUILD_ICONS_DIR = path.join(__dirname, '..', 'build', 'icons');

// Icon sizes needed for various platforms
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

async function generateCircularIcon(inputPath, outputPath, size) {
  // Create circular mask SVG
  const circleMask = Buffer.from(
    `<svg width="${size}" height="${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="white"/>
    </svg>`
  );

  // Read and resize the original logo, then apply circular mask
  await sharp(inputPath)
    .resize(size, size, {
      fit: 'cover',
      position: 'centre'
    })
    .composite([{
      input: circleMask,
      blend: 'dest-in'
    }])
    .png()
    .toFile(outputPath);

  console.log(`Generated: ${outputPath}`);
}

async function generateIcoFile(pngPaths, outputPath) {
  const buffers = pngPaths.map(p => fs.readFileSync(p));
  const icoBuffer = await pngToIco(buffers);
  fs.writeFileSync(outputPath, icoBuffer);
  console.log(`Generated: ${outputPath}`);
}

async function main() {
  // Dynamic import for ESM module
  pngToIco = (await import('png-to-ico')).default;

  // Ensure build/icons directory exists
  if (!fs.existsSync(BUILD_ICONS_DIR)) {
    fs.mkdirSync(BUILD_ICONS_DIR, { recursive: true });
  }

  // Generate circular PNGs at all sizes
  const generatedPngs = [];
  for (const size of ICON_SIZES) {
    const outputPath = path.join(BUILD_ICONS_DIR, `${size}x${size}.png`);
    await generateCircularIcon(LOGO_PATH, outputPath, size);
    generatedPngs.push({ path: outputPath, size });
  }

  // Generate icon.png (512x512) for general use
  const mainIconPath = path.join(BUILD_ICONS_DIR, 'icon.png');
  await generateCircularIcon(LOGO_PATH, mainIconPath, 512);

  // Generate .ico for Windows (use 16, 24, 32, 48, 64, 128, 256)
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoPngs = icoSizes.map(size =>
    path.join(BUILD_ICONS_DIR, `${size}x${size}.png`)
  );
  await generateIcoFile(icoPngs, path.join(BUILD_ICONS_DIR, 'icon.ico'));

  console.log('\nIcon generation complete!');
  console.log('Icons saved to:', BUILD_ICONS_DIR);
}

main().catch(console.error);
