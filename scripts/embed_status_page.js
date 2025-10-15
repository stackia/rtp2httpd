#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";

function usage() {
  console.error("Usage: node embed_status_page.js <input.html> <output.h>");
}

function escapeHtml(content) {
  return content
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .split("\n")
    .map((line) => `    "${line}\\n"`)
    .join("\n");
}

function main() {
  const [, , htmlPath, outputPath] = argv;
  if (!htmlPath || !outputPath) {
    usage();
    exit(1);
  }

  const html = readFileSync(resolve(htmlPath), "utf8");
  const escaped = escapeHtml(html);
  const header = [
    "#ifndef __STATUS_PAGE_H__",
    "#define __STATUS_PAGE_H__",
    "",
    "/* HTML content for status page - generated file, do not edit manually */",
    "static const char status_page_html[] =",
    escaped,
    ";",
    "",
    "#endif /* __STATUS_PAGE_H__ */",
    ""
  ].join("\n");

  writeFileSync(resolve(outputPath), header, "utf8");
}

main();
