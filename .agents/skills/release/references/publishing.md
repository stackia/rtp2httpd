# Publication and Recovery

Commands below use `<tag>` and task-owned notes paths as placeholders. Inspect `.github/workflows/release.yaml` when diagnosing CI; it is the source of truth for release jobs.

## Prepare a concrete release

Prepare notes using [notes.md](notes.md), then build and validate before any outstanding publication approval. Existing authorization to publish covers the release operations below.

Use a clean checkout of current `origin/main`. Check branch, worktree state, and remote refs. Preserve unrelated changes: a dirty development checkout is a reason to use an isolated release worktree, not to discard changes or stop drafting. If `main` is already checked out elsewhere, a temporary branch from `origin/main` in an isolated worktree can push `HEAD:main` normally after verifying the base. Do not force checkout or push.

```bash
git fetch origin main --tags
# In the clean main release checkout:
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run web-ui:build
pnpm run lint
```

Use the project's Node/Corepack setup. Correct build/lint failures introduced by release preparation and rerun the affected check. For unrelated failures requiring a broader change, report the blocker before publishing. Keep lockfiles unchanged during release preparation.

Review the generated diff and commit only `src/embedded_web_data.h` if changed, for example `chore(release): refresh embedded UI for <tag>`. An authorized release includes this generated-file commit. If publication authorization is still outstanding, leave this diff ready for review with the notes and validation results.

Before pushing, confirm the release base is still current, the intended release commit is clean, and the tag is unused locally and remotely. If `origin/main` advanced during preparation, incorporate it safely and reconcile affected notes/build results before tagging. Check for an existing GitHub Release too; resume a matching partial attempt instead of creating duplicates.

## Publish

Push the prepared commit to `main` before the annotated tag. In the clean main checkout:

```bash
git push origin main
git tag -a <tag> -m <tag>
git push origin <tag>
gh release create <tag> --verify-tag --title <tag> --notes-file /path/to/notes.md
```

For a prerelease, add `--prerelease` to the last command. From an isolated release branch, replace the main push with `git push origin HEAD:main`; verify that remote main contains the intended commit before tagging.

Publishing triggers `.github/workflows/release.yaml` on `release.published`. If a call fails or its result is uncertain, inspect the remote tag and release state before retrying. A matching existing tag may be reused for an interrupted publication; a tag pointing at a different commit requires resolution, never retagging.

## Remove the previous donation block

After publication, fetch the current body of the immediately previous release recorded during preparation. Remove only its canonical donation table, detecting it by the image URL in [notes.md](notes.md). Preserve all other text; use a temporary file and `gh release edit <previous-tag> --notes-file ...`.

Do not scan older releases for donation cleanup. Verify that the new release contains exactly one donation asset URL and the immediately previous release contains none. If this step fails, keep the new release and report the specific cleanup still needed.

## Collapse superseded prereleases after GA

Skip this step for a prerelease. For a formal release, use the same-base-version prerelease list collected for its notes. Fetch each current body and skip one already wrapped in a top-level `<details>` accordion. Otherwise preserve its body exactly inside:

```markdown
<details>
<summary>预发布说明（已并入 <formal-tag>） / Prerelease notes (included in <formal-tag>)</summary>

{original body}

</details>
```

Substitute the formal tag in the summary. Leave the blank line after the summary and omit the `open` attribute. Edit through `--notes-file`; do not change donation blocks during this step. Verify the default-hidden wrapper and preservation of the inner bilingual notes. Never wrap the new formal release or a different version series.

For transient API failures, re-read current state and make a bounded retry. Report any remaining tags/cleanup without deleting the new release. Run any Python helper with `uv run`.

## CI and stable

Locate the release's run, verifying its tag/commit rather than relying on an unrelated latest run:

```bash
gh run list --workflow=release.yaml --branch <tag> --limit 5 --json databaseId,headSha,status,conclusion,url
gh run view <run-id>
```

For prereleases, `versioned` is skipped by design. Do not wait for a Makefile commit or update `stable`.

For formal releases, the `versioned` job generates and commits:

- `openwrt-support/rtp2httpd/Makefile.versioned`
- `openwrt-support/luci-app-rtp2httpd/Makefile.versioned`

Its commit subject is `chore: update versioned Makefiles for <tag>`. Poll the run and fetch main at bounded intervals (about 30 seconds) for up to 10 minutes. Confirm job success and inspect the matching commit/files on `origin/main`; a matching subject alone is insufficient. Stop waiting on job failure or timeout and report the remaining stable step. Do not claim the rest of CI succeeded merely because `versioned` did.

After the matching versioned commit is present, fast-forward `stable` from its current remote tip to the verified main commit. In a clean checkout where these branches are available:

```bash
git fetch origin main stable
git switch stable
git pull --ff-only origin stable
git merge --ff-only origin/main
git push origin stable
git switch main
```

For an isolated release worktree, equivalent verified ref updates can avoid disturbing another checkout. If stable diverged, report the blocker; never force-push. Inspect any unrelated main advances before including them in stable.

Finish with the release URL, pushed tag, donation/prerelease cleanup results, stable result or deliberate prerelease skip, and actual CI status/run URL. If the user requested ready artifacts, continue through the relevant build/upload jobs. Clean up task-owned worktrees and temporary files when no longer needed, retaining notes/recovery files that are the requested deliverable or needed to resolve a failure.
