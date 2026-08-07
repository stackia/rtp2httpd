---
name: release
description: Execute the rtp2httpd release workflow — cumulative prerelease and formal release notes, tagging, GitHub releases, CI handling, and stable branch updates.
---

# rtp2httpd Release Workflow

This skill orchestrates the entire release process for `rtp2httpd`.

## Workflow Steps

Follow these steps in order.

---

### Step 0: Pre-flight Checks

- Ensure you are at the **rtp2httpd project root** (`cd` there first if needed).
- Check current branch with `git branch --show-current`.
- Check for uncommitted changes with `git status --porcelain`. If the workspace is not clean, abort with instructions.
- Fetch the latest release branch and tags before inspecting history with `git fetch origin main --tags`. Use
  `origin/main`, not a potentially stale local branch, as the endpoint for release-note diffs.
- Determine the **latest published non-draft release tag** using
  `gh release list --exclude-drafts --limit 1 --json tagName --jq '.[0].tagName'` (e.g., `v3.14.2-rc.2`). Save it as
  the immediately previous release tag so its donation block can be removed after publishing. "Immediately previous"
  means the most recently published non-draft GitHub Release, whether formal or prerelease.
- If the user supplied an explicit target tag, use that tag. Otherwise, inspect the latest formal and prerelease versions
  and compute the next tag after asking for the release type.
- Determine whether the target tag is a **prerelease** from its SemVer suffix, such as `-rc.1`, `-beta.2`, or
  `-alpha.1`. Also record its base version by stripping the suffix (for example, `v3.15.0-rc.2` has base version
  `v3.15.0`). Prereleases skip the versioned Makefile and `stable` branch steps.
- Enumerate releases with `gh release list --exclude-drafts --limit 100 --json tagName,isPrerelease,publishedAt`; if 100
  results are returned, increase the limit so the relevant release series cannot be truncated. Identify:
  - the previous formal release: the highest lower non-prerelease SemVer tag that is an ancestor of `origin/main`;
  - every published prerelease whose SemVer suffix can be stripped to exactly the target base version; and
  - the latest such prerelease by publication time, if any.
  These are release-note sources, not just version-number inputs. Never use prerelease notes from another base version.

---

### Step 1: Ask Release Type

If the user did not provide an explicit target tag, use `AskQuestion` with header "Release type":

> What type of release is this?

Options (single-select):
- **patch** — Bug fixes only (Z+1). Release notes are a simple bullet list.
- **minor** — New features + bug fixes (Y+1). Release notes split into "新功能 / 问题修复" (Chinese) and "New Features / Bug Fixes" (English).
- **major** — Breaking changes (X+1). Same format as minor.

Based on the answer and latest version, compute the new tag (e.g., `v3.15.0`).

---

### Step 2: Draft Release Notes

Release-note history and git history serve different purposes:

- Existing prerelease notes describe the complete user-facing change set expected for the upcoming formal release.
- Git history finds newly added work and verifies coverage; it must not cause previously documented prerelease changes to
  disappear merely because they fall outside the latest tag-to-`origin/main` diff.

#### Choose the release-note sources

**For a prerelease:** use rolling cumulative notes.

1. Fetch the body of every existing prerelease for the same base version with `gh release view <tag> --json body`.
2. Use the latest prerelease body as the primary draft because it should already contain the accumulated notes.
3. Compare it with earlier prerelease bodies in the same series and carry forward any still-relevant user-facing item that
   is missing. A new prerelease must include all applicable content from all earlier prereleases in that series.
4. Inspect commits after the immediately previous prerelease tag to find new items. For the first prerelease in a series,
   inspect commits after the latest formal release tag instead.
5. Merge the new items into the accumulated draft. Do not replace the draft with only the latest git diff.

**For a formal release:** prefer the prerelease notes for that version.

1. If the same base version has prereleases, fetch their bodies and use the latest prerelease body as the primary draft.
2. Compare all earlier prerelease bodies in the series and restore any still-relevant item missing from the latest one.
3. Inspect commits after the latest prerelease tag and add any newly introduced user-facing changes.
4. Cross-check commits from the previous formal release through `origin/main` for omissions, but preserve the prerelease
   wording where it remains accurate. The formal notes should represent the finalized cumulative prerelease notes plus
   later work.
5. If no prerelease exists for the target version, draft from commits after the previous formal release as usual.

Before using a source tag, verify that it belongs to the release branch with
`git merge-base --is-ancestor "<source-tag>" origin/main`. Abort for clarification if it is not an ancestor. Use git
history for the applicable ranges above:

```bash
git log "<source-tag>..origin/main" --oneline --no-merges --format="%s (%h)"
```

Categorize commits by type (`feat:`, `fix:`, `perf:`, `refactor:`, `chore:` etc.) to understand what changed. Treat commit
subjects as evidence, not release-note copy: retain user-focused wording from existing release notes when possible.

#### Merge and normalize the notes

- Preserve accumulated items even if they were introduced by an older prerelease in the same series.
- Add genuinely new user-facing changes from git history or user-provided notes.
- Deduplicate semantically equivalent bullets across prereleases and new changes; do not repeat an item merely because its
  wording changed.
- Remove an accumulated item only when it was reverted, superseded, proven inaccurate, or the user explicitly asks to
  remove it. If the evidence is ambiguous, keep it and flag it during review rather than silently dropping it.
- User-provided corrections take precedence over inherited wording. Otherwise, avoid gratuitously rewriting established
  prerelease notes when preparing the formal release.
- Normalize each source body before merging: remove the complete donation table using the donation asset URL as its
  marker, then split at the standalone `---` separator into Chinese and English sections. Do not confuse that separator
  with the donation table's `| --- |` row.
- Treat each retained or new change as a bilingual item pair. Merge and deduplicate the pairs, keep the two language
  sections semantically aligned, and update the counterpart translation whenever a correction changes one language.
- Rebuild the canonical structure below only after merging so the final file contains exactly one donation block.

Draft bilingual release notes **in a file** (e.g., `/tmp/release-notes-v3.x.y.md`) following these conventions.

Release notes must always contain both Chinese and English:

- If the user supplies only Chinese release notes, preserve the Chinese text and append a faithful English translation.
- If the user supplies only English release notes, preserve the English text and add a faithful Chinese translation before it.
- If the user supplies both languages, preserve both and only make changes needed for consistent formatting.
- Place the canonical donation block after the Chinese content and before the `---` separator.
- Separate the Chinese section (including its donation block) from the English section with `---`.
- Never publish single-language release notes, even when the user supplied the wording.

**Patch release format:**
```markdown
- {Chinese description}
  - Detail if needed
- {Chinese description}

| 如果这个项目对你有帮助，不妨请作者喝一杯咖啡 ☕️ |
| --- |
| <img width="360" src="https://github.com/user-attachments/assets/fc5c3498-40e9-43b9-93a3-6a5a7917847b" /> |

---

- {English description}
  - Detail if needed
- {English description}
```

**Minor/major release format:**
```markdown
## 新功能

- {feature description in Chinese}
  - Detail if needed
- ...

## 问题修复

- {fix description in Chinese}
  - Detail if needed
- ...

| 如果这个项目对你有帮助，不妨请作者喝一杯咖啡 ☕️ |
| --- |
| <img width="360" src="https://github.com/user-attachments/assets/fc5c3498-40e9-43b9-93a3-6a5a7917847b" /> |

---

## New Features

- {feature description in English}
  - Detail if needed
- ...

## Bug Fixes

- {fix description in English}
  - Detail if needed
- ...
```

Always include this canonical donation block in the new release, regardless of whether the release is a patch,
minor, major, or prerelease:

```markdown
| 如果这个项目对你有帮助，不妨请作者喝一杯咖啡 ☕️ |
| --- |
| <img width="360" src="https://github.com/user-attachments/assets/fc5c3498-40e9-43b9-93a3-6a5a7917847b" /> |
```

Place the block exactly once, immediately after the Chinese content and before the `---` separator that introduces
the English content. Do not append another donation block after the English content. If the user-provided notes
already contain the block, move it to the required position if necessary rather than adding a duplicate.

**Release notes guidelines:**
- ✅ End-user focused — target audience is rtp2httpd users, not developers
- ✅ Avoid internal implementation details (e.g., "refactored X module", "upgraded Y dependency")
- ✅ Mention the web player / OpenWrt / Docker / specific feature areas where relevant
- ✅ Be concise; one short bullet per change with optional sub-bullet for context
- ✅ Bilingual: Chinese first, English second (separated by `---`)
- ✅ Include exactly one canonical donation block between the Chinese content and the `---` separator
- ❌ Do not include `Closes` / `Fixes #123` — those belong in git history only

Show the drafted notes to the user by reading and outputting the **full release notes file content** so the user can
directly review the complete bilingual notes and donation block.

### Step 3: Confirm with User

Use `AskQuestion` with header "Ready to release?":

> Ready to create release v3.x.y?

Show a summary: release notes file path, the release-note sources used (including inherited prereleases), lint, tag
creation, release creation, previous-release donation cleanup, and the CI/stable behavior appropriate for a formal
release or prerelease.

Options:
- **Yes, release it!** — proceed with the release
- **No, let me make changes first** — abort
- **No, let me edit release notes** — user edits the notes file, then mark task as complete

After user approval, continue.

---

### Step 4: Ensure on `main` with a Clean Workspace

```bash
# Switch to main if not already there, only if workspace is clean
git checkout main
git pull --ff-only origin main
```

If there are uncommitted changes preventing a branch switch, advise the user to stash or commit first and abort.

---

### Step 5: Build Web UI

First, install frontend dependencies to avoid stale local caches:

```bash
pnpm install
```

Then regenerate `src/embedded_web_data.h` so the released binary includes the latest frontend:

```bash
pnpm run web-ui:build
```

This updates `src/embedded_web_data.h`. Commit it if it changed:

```bash
git add src/embedded_web_data.h
git commit -m "chore: update embedded_web_data.h for v3.x.y"
```

If the file did not change (no diff), skip the commit.

---

### Step 6: Run Lint

```bash
pnpm run lint
```

If lint fails, show the output and ask the user whether to fix and retry or abort.

---

### Step 7: Push `main`, Then Create and Push Tag

```bash
git push origin main
git tag -a "v3.x.y" -m "v3.x.y"
git push origin "v3.x.y"
```

### Step 8: Create GitHub Release

For a formal release:

```bash
gh release create "v3.x.y" \
  --title "v3.x.y" \
  --notes-file /tmp/release-notes-v3.x.y.md
```

For a prerelease, include `--prerelease`:

```bash
gh release create "v3.x.y-rc.n" \
  --title "v3.x.y-rc.n" \
  --notes-file /tmp/release-notes-v3.x.y-rc.n.md \
  --prerelease
```

After this, the CI release workflow is triggered automatically (it listens for `release.published` events).

### Step 9: Remove the Donation Block from the Previous Release

Only the latest published release, including a prerelease, may display the donation QR code. Immediately after the
new release is published, inspect only the previous release tag recorded during Step 0 and remove the canonical
donation table from that release if it contains one.

- Use the donation image asset URL as the stable marker when detecting the block.
- Preserve all other release-note content exactly.
- Do not remove the donation block from the newly published release.
- Do not scan or edit releases older than the immediately previous release.
- Use temporary files and `gh release edit --notes-file` rather than passing multiline notes as command arguments.
- Run Python helpers through `uv run`, never directly through `python`.
- Verify afterward that the new release contains the donation asset URL and the previous release does not.
- If cleanup fails after publishing, report that the previous release still contains the block and provide a safe retry command;
  do not delete or recreate the new release.

The intended end state is:

```text
latest published release (formal or prerelease): exactly one donation block
immediately previous release: no donation block
```

### Step 10: Handle the CI `versioned` Job

#### Prerelease

If the GitHub Release is a prerelease, **skip this step entirely**. The workflow intentionally skips the `versioned`
job for prereleases, so do not poll for a versioned Makefile commit and do not treat the skipped job as a failure.

#### Formal release

The CI workflow has a `versioned` job that commits `Makefile.versioned` files back to the `main` branch. Wait for this commit to appear on `main`:

```bash
# Loop until the versioned makefiles commit appears on main
# The commit message pattern is "chore: update versioned Makefiles for v3.x.y"
while true; do
  git fetch origin main
  if git log origin/main --oneline --grep="versioned Makefiles for v3.x.y" | head -1 | grep -q "v3.x.y"; then
    echo "Versioned Makefiles commit found!"
    break
  fi
  echo "Waiting for versioned Makefiles commit... (retry in 30s)"
  sleep 30
done

# Update local main
git pull origin main
```

If the CI run fails or the commit doesn't appear within 10 minutes, alert the user and stop. Check CI status via:

```bash
# Get the latest workflow run ID for the release tag
gh run list --workflow=release.yaml --branch "v3.x.y" --limit 1 --json databaseId,status,conclusion --jq '.[0]'
```

### Step 11: Update `stable` Branch for Formal Releases Only

If the release is a prerelease, skip this step and leave `stable` unchanged.

For a formal release:

```bash
git checkout stable
git pull origin stable
git merge --ff-only origin/main
git push origin stable
```

If `git merge --ff-only origin/main` fails (non-fast-forward), it means the `stable` branch has diverged — alert the user and abort. Do not force-push.

---

### Step 12: Return to `main`

```bash
git checkout main
```

---

### Step 13: Summary

For a formal release, print a completion summary:

```
✅ Release v3.x.y complete!

- Tag: v3.x.y (pushed)
- GitHub Release: https://github.com/stackia/rtp2httpd/releases/tag/v3.x.y
- stable branch: updated (fast-forward merge)
- CI: running (Docker, OpenWRT, static binaries, macOS)
```

For a prerelease, explicitly report that versioned Makefile polling and the `stable` update were skipped by design:

```text
✅ Prerelease v3.x.y-rc.n complete!

- Tag: v3.x.y-rc.n (pushed)
- GitHub Release: https://github.com/stackia/rtp2httpd/releases/tag/v3.x.y-rc.n
- Donation QR: present only on this latest release
- Versioned Makefiles: skipped for prerelease
- stable branch: unchanged
- CI: running (Docker, OpenWRT, static binaries, macOS)
```

## Notes

- The CI release workflow (`release.yaml`) builds Docker images, OpenWRT IPK/APK packages, Linux/macOS/FreeBSD static binaries, and uploads them as release assets.
- For formal releases, the `versioned` job commits `openwrt-support/rtp2httpd/Makefile.versioned` and
  `openwrt-support/luci-app-rtp2httpd/Makefile.versioned` back to `main`.
- For prereleases, the `versioned` job is intentionally skipped and `stable` must remain unchanged.
- Release notes are always bilingual, even if the user provides only one language.
- Prerelease notes are rolling and cumulative across the same base-version series; never reduce them to only the changes
  since the immediately previous prerelease.
- A formal release should inherit the cumulative notes from the latest prerelease for the same base version, reconcile
  earlier prerelease omissions, and add changes made afterward.
- The latest published release always contains the donation QR block after its Chinese content; the immediately
  previous release has that block removed after publishing.
- Never force-push to `main` or `stable`.
- Use `gh run list` and `gh run view` to monitor CI progress.
- If something goes wrong mid-release, communicate clearly what happened and what manual recovery steps are needed.
