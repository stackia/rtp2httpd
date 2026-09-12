---
name: release
description: Prepare rtp2httpd release notes or publish a requested version, including prerelease and stable-branch handling.
---

# Releases

Match the requested outcome: drafting notes ends with a reviewable notes file; publishing continues through release creation and the applicable cleanup/CI/stable steps. An explicit request to publish is authorization; do not ask for the same approval again. If publication has not been authorized, finish preparation before asking to publish.

## Select the work

- For notes, version selection, and cumulative prerelease history, read [notes.md](references/notes.md).
- For build preparation, publication, recovery, and CI/stable handling, read [publishing.md](references/publishing.md). Load it only when preparing or executing publication.

Use the user's target tag or release type. If neither the request nor context determines the version, inspect release history and ask only for the missing version decision; note drafting can proceed meanwhile.

## Invariants

- Notes are cumulative within one base-version series, Chinese first and English second, with one canonical donation block. Preserve user corrections and still-relevant inherited changes.
- Publish from an up-to-date, clean `main` release checkout. An authorized release includes regenerating and committing `src/embedded_web_data.h` if changed.
- Only the newest published release retains the donation block. After publication, remove it from the immediately previous published release.
- Formal releases also collapse same-series prerelease notes and update `stable` after the versioned Makefiles job succeeds. Prereleases leave `stable` and earlier prerelease visibility unchanged.
- Never force-push `main`/`stable`, move an existing release tag, or delete/recreate a published release to recover from a later failure.

## Completion

Report the notes file or published release URL, exact tag, cleanup/stable results, and actual CI status. If assets are still building, say so; publication does not prove all artifacts are ready. Continue any requested CI/runtime verification to its result, or report the concrete blocker and remaining work.
