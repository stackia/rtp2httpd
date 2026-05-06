---
name: translate-docs-zh-en
description: >
  Translate and synchronize rtp2httpd Chinese documentation into English. ALWAYS use this skill
  whenever Chinese docs under docs/ need English translations under docs/en/, when Chinese doc diffs
  need to be reflected in existing English files, when VitePress English sidebar entries need to
  mirror Chinese docs, or when translation terminology needs to stay consistent across docs.
argument-hint: "[new|update|batch] [docs path or diff context]"
---

# Translate rtp2httpd Docs from Chinese to English

Use this skill to keep English documentation faithful to the Chinese source of truth.
Chinese docs under `docs/` are authoritative; English docs under `docs/en/` are translations.

Before translating, read `references/translation-memory.md` for established terminology and
project-specific conventions. Update that reference when you confirm stable terminology,
documentation structure, sidebar patterns, or other reusable translation decisions.

## Core Responsibilities

1. Translate Chinese documentation files to English, writing output to the corresponding path under `docs/en/`.
2. For new documents, read the full Chinese source and produce a complete English translation.
3. For document updates, read the Chinese diff, identify changed sections, and update only the corresponding English sections.

## Translation Rules

### Structure Preservation

- Mirror the Chinese Markdown structure, heading hierarchy, link anchors, code blocks, and document layout.
- Translate frontmatter fields containing user-facing text. Keep frontmatter keys unchanged.
- Preserve VitePress syntax such as `::: tip`, `::: warning`, `::: danger`, `::: info`, `::: details`, and custom containers. Translate the content inside containers.

### Link Handling

- Internal/site links: add the `/en/` prefix. Example: `/guide/quick-start` becomes `/en/guide/quick-start`.
- External links: keep unchanged.
- Relative image/asset paths: add one extra `../` because English docs live one level deeper under `docs/en/`.
  - `docs/index.md` using `./images/foo.png` becomes `docs/en/index.md` using `../images/foo.png`.
  - `docs/guide/bar.md` using `../images/foo.png` becomes `docs/en/guide/bar.md` using `../../images/foo.png`.
- Absolute paths starting with `/`: keep unchanged.
- Anchor links: translate anchor text and update anchor targets to match translated headings using VitePress anchor generation.

### Do Not Translate

- Code inside inline or fenced code blocks, shell commands, configuration parameter names, and variable names.
- URLs, IP addresses, and port numbers.
- Product and project names such as rtp2httpd, udpxy, VLC, and FFmpeg.
- File paths and filenames.

### Special Handling

- For China-specific concepts, retain the original term only when needed and add an English explanation.
- Keep common technical acronyms as-is, including RTP, HTTP, UDP, IGMP, FCC, and FEC.
- In English docs, avoid leaving Chinese characters unless they are intentionally retained terms with explanations.
- In code/config examples, translate Chinese sample values to English equivalents, such as `group-title="央视"` to `group-title="CCTV"`.

## English Documentation Style

- Use clear, concise technical English that reads naturally to a native English-speaking developer.
- Match the original tone without becoming overly formal or casual.
- Prefer active voice where natural.
- Preserve precise meaning. Do not generalize, soften, omit qualifiers, or change numeric values.
- If the Chinese source has inconsistent values, flag the inconsistency instead of silently choosing one.

### Page Titles

- "详解" / "参数详解" -> "Reference", for example "配置参数详解" -> "Configuration Reference".
- "说明" -> a simple noun form or "Guide", for example "URL 格式说明" -> "URL Formats".
- "报告" -> drop it when redundant, for example "性能测试报告" -> "Performance Benchmark".
- "建议" -> "Guide" rather than "Recommendations", for example "公网访问建议" -> "Public Access Guide".
- Use plural forms when a page covers multiple items, such as "URL Formats".
- Avoid "Specification" unless the document is an actual standard/specification.

### Terminology

- Prefer "build" over "compile" for software construction, except when referring to literal commands such as `make ... compile`.
- Translate "后台" as "admin panel" or "admin interface", not "backend".
- Translate "花屏" as "artifacts" and "卡顿" as "stuttering".
- Use "traffic interception" or "packet capture via gateway", not "man-in-the-middle", for packet capture setups.

## Workflow

### New File Translation

1. Read the Chinese source file completely.
2. Create the corresponding file under `docs/en/` with the same relative path.
3. Translate the entire document using the rules above.
4. Check whether `docs/.vitepress/config.ts` needs a matching English sidebar entry.
5. Self-review for structure, links, code blocks, frontmatter, and completeness.

### Existing File Updates

1. Read the diff of the Chinese document to identify changed sections.
2. Open the existing English translation.
3. Locate corresponding sections in the English file.
4. Update only the changed sections.
5. Verify the updated surrounding context still reads naturally.

### Batch Translation

1. List all files that need translation.
2. Translate in logical order, usually overview/index files first.
3. Verify the English sidebar in `docs/.vitepress/config.ts` is complete.

## VitePress Config Updates

- Locate the English locale sidebar configuration, usually under `en` or `/en/`.
- Add entries that mirror the Chinese sidebar structure with translated text and `/en/`-prefixed links.
- Do not modify the Chinese locale configuration unless the user explicitly asks.

## Quality Checklist

Before finishing each file, verify:

- All headings are translated and hierarchy matches the Chinese source.
- Internal links have `/en/` prefixes.
- External links are unchanged.
- Relative image/asset paths have one additional `../`.
- Code blocks are untouched.
- Product and project names are not translated.
- VitePress container syntax is preserved.
- Frontmatter text fields are translated.
- No unintended Chinese characters remain in English docs.
- Cross-reference link text matches the target page H1.

## Cross-Reference Consistency

When a document links to another page, the link text must match the H1 title of the target page.
After translating or updating a page title, search English docs for references to that page and
update stale link text in related documentation, next steps sections, and inline references.

## Updating Translation Memory

Use `references/translation-memory.md` as the persistent project memory for this skill.

Record:

- Stable terminology choices.
- Document structure and sidebar conventions.
- China-specific concepts and their established English rendering.
- File organization patterns between Chinese and English docs.

Do not record:

- Session-specific task state.
- Speculative or unverified conclusions.
- Anything that duplicates or contradicts repo instructions in `AGENTS.md` or `CLAUDE.md`.
