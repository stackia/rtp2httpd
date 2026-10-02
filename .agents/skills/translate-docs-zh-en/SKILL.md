---
name: translate-docs-zh-en
description: Translate Chinese rtp2httpd docs into docs/en/ and synchronize English navigation, links, and terminology after source changes.
---

# Chinese to English Documentation

Chinese files in `docs/` are authoritative; map each to the same relative path under `docs/en/`. Use [translation-memory.md](references/translation-memory.md) for established terminology and alert conventions when translating affected content.

For a new page, translate the full source. For an update, use the Chinese diff and surrounding context to update the corresponding English sections. For a batch, apply the same rules to the requested files and their navigation. Do not rewrite unrelated translations or change the Chinese source to resolve a translation ambiguity; flag a source inconsistency while completing unaffected work.

## Preserve meaning and structure

- Preserve heading hierarchy, lists, tables, qualifiers, and numeric values. Translate user-facing frontmatter values, keeping keys intact.
- Preserve source markup: GitHub alert markers such as `> [!NOTE]` and any existing VitePress container delimiters. Translate their prose, including bold alert lead-ins.
- Keep executable syntax, shell commands, config keys, identifiers, URLs, addresses, ports, paths, product names, and acronyms unchanged. In examples, translate human-readable comments and illustrative display values such as `group-title="央视"` to `group-title="CCTV"` only when doing so preserves behavior. Keep semantically required literals unchanged.
- Retain Chinese terms only where the established convention requires them, with an English explanation. Keep English concise and faithful to the source.

## Resolve links by their role

- Site-page links should target the English counterpart, e.g. `/guide/quick-start` → `/en/guide/quick-start`. Relative page links can stay relative when they resolve within the mirrored English tree. Avoid adding a second `/en/` prefix.
- Shared assets stay shared: adjust a relative path to resolve from the English file's location (usually one extra `../`); root-relative asset URLs remain unchanged. For example, `docs/guide/a.md` linking `../images/foo.png` needs `../../images/foo.png` in `docs/en/guide/a.md`.
- External URLs remain unchanged, including Chinese-only tutorials.
- For translated headings, update generated anchor targets and incoming links. Preserve explicit anchor IDs when the source defines them.
- When link text names a page, use that page's English H1. Descriptive inline link text should retain its intended meaning.

## Navigation and completion

For new, moved, or retitled pages, mirror the relevant Chinese navigation in the English locale of `docs/.vitepress/config.ts`. Keep the Chinese locale unchanged unless the task includes changing it. After title/anchor changes, find and update affected English references.

Check the diff for complete translation, valid links/assets, and preserved example behavior. Run `pnpm run docs:build` when page paths, navigation, anchors, or Markdown/VitePress structure changed; a wording-only edit can use focused review. Correct failures caused by the translation before finishing.

Keep the terminology reference limited to confirmed, reusable translation choices; update it only when this work establishes one. Do not add session logs or duplicate repository rules.
