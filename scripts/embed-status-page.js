#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { gzipSync } from "node:zlib";

function usage() {
  console.error("Usage: node embed-status-page.js <input.html> <output.h>");
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
  const [, , htmlPath, outputPath] = argv;
  if (!htmlPath || !outputPath) {
    usage();
    exit(1);
  }

  const html = readFileSync(resolve(htmlPath), "utf8");
  const compressed = gzipSync(html, { level: 9 });
  const etag = generateEtag(compressed);

  const header = [
    "#ifndef __STATUS_PAGE_H__",
    "#define __STATUS_PAGE_H__",
    "",
    "#include <stdint.h>",
    "",
    "/* Compressed HTML content for status page - generated file, do not edit manually */",
    `static const char status_page_etag[] = ${etag};`,
    "static const uint8_t status_page_html[] = {",
    formatByteArray(compressed),
    "};",
    "",
    "#endif /* __STATUS_PAGE_H__ */",
    "",
  ].join("\n");

  writeFileSync(resolve(outputPath), header, "utf8");
}

main();
