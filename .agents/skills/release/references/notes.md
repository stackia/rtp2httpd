# Release Notes

Commands run from the repository root. Draft notes in a task-owned file outside the tracked tree, ready for `gh release create --notes-file`.

## Find the sources

Fetch `origin/main` and tags before selecting history:

```bash
git fetch origin main --tags
gh release list --exclude-drafts --limit 100 --json tagName,isPrerelease,publishedAt
```

Increase the limit if the relevant history is truncated. Record:

- The previous formal release: the highest lower non-prerelease SemVer tag that is an ancestor of `origin/main`.
- All published prereleases with exactly the target's base version after stripping its suffix, and the latest by publication time.

An explicit tag determines the target and prerelease status. Otherwise use the requested patch/minor/major or prerelease increment. Ask only when that choice remains unresolved. A patch uses simple bullets; a minor/major uses the feature/fix sections below, including for its prereleases.

## Build a cumulative draft

Fetch same-series prerelease bodies with `gh release view <tag> --json body`. For both a later prerelease and its formal release, start with the latest same-series body and reconcile every earlier body for still-relevant missing items. Never inherit from a different base version.

Inspect commits after the latest same-series prerelease for additions. If there is no such prerelease, start from the previous formal release. Also cross-check the full previous-formal-to-`origin/main` range for coverage when finalizing a formal release:

```bash
git merge-base --is-ancestor <source-tag> origin/main
git log <source-tag>..origin/main --no-merges --format='%s (%h)'
```

If a source tag is not an ancestor, resolve the intended release branch/range before using that diff. Commit subjects identify work; write notes for end users, preserving accurate existing wording. Deduplicate equivalent items. Remove an inherited item only when reverted, superseded, demonstrably inaccurate, or explicitly removed by the user. Flag uncertainty without silently dropping content.

Normalize source bodies before merging: unwrap an outer `<details>` accordion, remove its summary, and split languages at the standalone `---`. Merge Chinese/English item pairs together so corrections remain aligned.

## Canonical format

Keep user-provided wording and add the missing language if only one is supplied. For minor/major releases:

```markdown
## 新功能

- 中文功能说明

## 问题修复

- 中文修复说明

---

## New Features

- English feature description

## Bug Fixes

- English fix description
```

For patch releases, omit the feature/fix headings and use one bullet list per language.

Keep notes concise and user-facing, naming player/OpenWrt/Docker areas when useful. Omit internal refactors, dependency churn without user impact, and `Closes`/`Fixes #...` bookkeeping. Check bilingual coverage and final formatting, then show the complete notes for review when drafting or seeking publication approval. A draft-only request needs no build, tag, or GitHub mutation.
