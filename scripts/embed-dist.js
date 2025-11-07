#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { argv, exit } from "node:process";
import { gzipSync } from "node:zlib";

function usage() {
  console.error("Usage: node embed-dist.js <dist-dir> <output.h>");
  console.error("  dist-dir: path to the dist directory (e.g., web-ui/dist)");
  console.error("  output.h: output header file (e.g., src/embedded_web.h)");
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

function generateEtag(buffer) {
  const hash = createHash("sha256").update(buffer).digest("hex");
  return `"${hash}"`;
}

function getMimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".webp": "image/webp",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

function hasHashInFilename(filename) {
  // Match patterns like: name-a1b2c3d4.js, name-A1B2-3C4D.css, etc.
  // Vite generates hashes like: [name]-[hash].js where hash contains alphanumeric chars and hyphens
  // Match: player-JMsuKSSN.js, status-BtNSEM5x.js, use-locale-BAU8V-1E.css
  return /-[a-zA-Z0-9-]{6,}\.(js|css|png|jpg|svg|woff2?)$/i.test(filename);
}

function scanDirectory(dir, baseDir = dir) {
  const files = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...scanDirectory(fullPath, baseDir));
    } else if (stat.isFile()) {
      const relativePath = "/" + relative(baseDir, fullPath).replace(/\\/g, "/");
      files.push({
        path: relativePath,
        fullPath,
        hasHash: hasHashInFilename(entry),
      });
    }
  }

  return files;
}

function sanitizeVarName(path) {
  // Convert path to valid C identifier
  // /status.html -> data_status_html
  // /assets/main-abc123.js -> data_assets_main_abc123_js
  return "data_" + path.replace(/[^a-zA-Z0-9]/g, "_");
}

function main() {
  const [, , distDir, outputPath] = argv;
  if (!distDir || !outputPath) {
    usage();
    exit(1);
  }

  console.log(`Scanning directory: ${distDir}`);
  const files = scanDirectory(distDir);
  console.log(`Found ${files.length} files`);

  const embeddedFiles = [];
  let totalCompressedSize = 0;
  let totalOriginalSize = 0;

  // Process each file
  for (const file of files) {
    const content = readFileSync(file.fullPath);
    const compressed = gzipSync(content, { level: 9 });
    const varName = sanitizeVarName(file.path);
    const mimeType = getMimeType(file.path);
    const etag = file.hasHash ? null : generateEtag(compressed);

    totalOriginalSize += content.length;
    totalCompressedSize += compressed.length;

    embeddedFiles.push({
      path: file.path,
      varName,
      mimeType,
      etag,
      compressed,
      hasHash: file.hasHash,
    });

    const cacheType = file.hasHash ? "immutable" : "etag";
    console.log(
      `  ${file.path} (${(content.length / 1000).toFixed(1)}KB → ${(compressed.length / 1000).toFixed(1)}KB, ${cacheType})`
    );
  }

  console.log(
    `\nTotal size: ${(totalOriginalSize / 1000).toFixed(1)}KB → ${(totalCompressedSize / 1000).toFixed(1)}KB ` +
    `(${((1 - totalCompressedSize / totalOriginalSize) * 100).toFixed(1)}% reduction)`
  );

  // Generate header file
  const lines = [
    "#ifndef EMBEDDED_WEB_DATA_H",
    "#define EMBEDDED_WEB_DATA_H",
    "",
    "#include <stdint.h>",
    "#include <stddef.h>",
    "#include <stdbool.h>",
    "",
    "/* Embedded web files - auto-generated, do not edit manually */",
    "",
  ];

  // Declare data arrays for each file
  for (const file of embeddedFiles) {
    lines.push(
      `/* ${file.path} (${(file.compressed.length / 1000).toFixed(1)}KB gzipped) */`
    );
    lines.push(`static const uint8_t ${file.varName}[] = {`);
    lines.push(formatByteArray(file.compressed));
    lines.push("};");
    lines.push("");
  }

  // Include embedded_web.h for the type definition
  lines.push("/* Include embedded_web.h for embedded_file_t definition */");
  lines.push("#include \"embedded_web.h\"");
  lines.push("");

  // Define the array
  lines.push("static const embedded_file_t embedded_files[] = {");
  for (const file of embeddedFiles) {
    const etagStr = file.etag ? file.etag : "NULL";
    const hasHashStr = file.hasHash ? "true" : "false";
    lines.push(
      `    {"${file.path}", "${file.mimeType}", ${etagStr}, ${file.varName}, sizeof(${file.varName}), ${hasHashStr}},`
    );
  }
  lines.push("};");
  lines.push("");

  lines.push(`#define EMBEDDED_FILES_COUNT ${embeddedFiles.length}`);
  lines.push("");
  lines.push("#endif /* EMBEDDED_WEB_DATA_H */");
  lines.push("");

  writeFileSync(outputPath, lines.join("\n"), "utf8");
  console.log(`\nGenerated ${outputPath}`);
}

main();
