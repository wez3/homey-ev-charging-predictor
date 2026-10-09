'use strict';

// Renders the App Store and driver PNGs from their SVG sources in assets/src.
// sharp comes in with the `homey` dev dependency.

const sharp = require('sharp');

const JOBS = [
  ['assets/src/app-image.svg', 'assets/images/large.png', 500, 350],
  ['assets/src/app-image.svg', 'assets/images/small.png', 250, 175],
  ['assets/src/driver-image.svg', 'drivers/ev_charging_predictor/assets/images/large.png', 500, 500],
  ['assets/src/driver-image.svg', 'drivers/ev_charging_predictor/assets/images/small.png', 75, 75],
];

(async () => {
  for (const [src, out, width, height] of JOBS) {
    // Rasterise well above the target size and downsample, so thin lines and
    // text stay crisp at the small sizes.
    await sharp(src, { density: 300 }).resize(width, height).png().toFile(out);
    console.log(`${out} (${width}x${height})`);
  }
})();
