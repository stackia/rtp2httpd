#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { gzipSync } from "node:zlib";

function usage() {
  console.error(
    "Usage: node embed-page.js <page-type> <input.html> <output.h>",
  );
  console.error("  page-type: 'status' or 'player'");
}

function formatByteArray(buffer) {
  const bytesPerLine = 24;
  const lines = [];

  for (let offset = 0; offset < buffer.length; offset += bytesPerLine) {
    const slice = buffer.slice(offset, offset + bytesPerLine);
    const line = slice.join(", ");
    lines.push(`    ${line},`);
  }

  if (lines.length > 0) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = lines[lastIndex].replace(/,\s*$/, "");
  }

  return lines.join("\n");
}

function quoteEtag(hash) {
  return `"${hash}"`;
}

function generateEtag(buffer) {
  const hash = createHash("sha256").update(buffer).digest("hex");
  return quoteEtag(hash);
}

function main() {
  const [, , pageType, htmlPath, outputPath] = argv;
  if (!pageType || !htmlPath || !outputPath) {
    usage();
    exit(1);
  }

  if (pageType !== "status" && pageType !== "player") {
    console.error(`Error: Invalid page type "${pageType}"`);
    usage();
    exit(1);
  }

  const html = readFileSync(resolve(htmlPath), "utf8");
  const compressed = gzipSync(html);
  const etag = generateEtag(compressed);

  console.log(
    `[${pageType}] Compressed size: ${(compressed.length / 1000).toFixed(2)} KB`,
  );

  const guardName = `__${pageType.toUpperCase()}_PAGE_H__`;
  const varPrefix = `${pageType}_page`;

  const header = [
    `#ifndef ${guardName}`,
    `#define ${guardName}`,
    "",
    "#include <stdint.h>",
    "",
    `/* Compressed HTML content for ${pageType} page - generated file, do not edit manually */`,
    `static const char ${varPrefix}_etag[] = ${etag};`,
    `static const uint8_t ${varPrefix}_html[] = {`,
    formatByteArray(compressed),
    "};",
    "",
    `#endif /* ${guardName} */`,
    "",
  ].join("\n");

  writeFileSync(resolve(outputPath), header, "utf8");
}

main();
