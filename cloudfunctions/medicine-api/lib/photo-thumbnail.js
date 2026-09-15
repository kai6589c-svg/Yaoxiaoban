"use strict";

// Pure JavaScript codecs work in the existing Node 16 cloud runtime without
// shipping a macOS native binary. Bound decode work before touching pixels.
const jpeg = require("jpeg-js");
const { PNG } = require("pngjs");
const EDGE = 400;
const MAX_BYTES = 100 * 1024;

function createThumbnail(content, metadata) {
  if (metadata.width * metadata.height > 4_000_000) return null;
  let source;
  if (metadata.mimeType === "image/jpeg") {
    source = jpeg.decode(content, {
      useTArray: true,
      maxResolutionInMP: 4,
      maxMemoryUsageInMB: 64,
      tolerantDecoding: false,
    });
  } else if (metadata.mimeType === "image/png") {
    source = PNG.sync.read(content, { checkCRC: true });
  } else return null;
  const scale = Math.min(1, EDGE / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const data = Buffer.alloc(width * height * 4);
  // Area averaging preserves small label text better than nearest-neighbour.
  for (let y = 0; y < height; y++) {
    const top = Math.floor((y * source.height) / height);
    const bottom = Math.max(
      top + 1,
      Math.floor(((y + 1) * source.height) / height),
    );
    for (let x = 0; x < width; x++) {
      const left = Math.floor((x * source.width) / width);
      const right = Math.max(
        left + 1,
        Math.floor(((x + 1) * source.width) / width),
      );
      const sums = [0, 0, 0];
      for (let sy = top; sy < bottom; sy++)
        for (let sx = left; sx < right; sx++) {
          const offset = (sy * source.width + sx) * 4;
          const alpha = source.data[offset + 3] / 255;
          for (let c = 0; c < 3; c++)
            sums[c] += source.data[offset + c] * alpha + 255 * (1 - alpha);
        }
      const count = (bottom - top) * (right - left);
      const offset = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        data[offset + c] = Math.round(sums[c] / count);
      data[offset + 3] = 255;
    }
  }
  let result = jpeg.encode({ data, width, height }, 72).data;
  if (result.length > MAX_BYTES)
    result = jpeg.encode({ data, width, height }, 55).data;
  return result.length <= MAX_BYTES ? result : null;
}

module.exports = { createThumbnail };
