---
name: sync-fcc-ip-docs
description: Check or update the rtp2httpd FCC address collection using community reports in GitHub issue 5.
---

# FCC Address Collection

Curate reports from <https://github.com/stackia/rtp2httpd/issues/5>. Use [update-memory.md](references/update-memory.md) for the checkpoint, document paths, locality caveats, and grouping conventions. These are community reports, not proof of reachability from the current machine.

A check/review request returns findings without editing docs, advancing the checkpoint, or reacting on GitHub. A sync/update request covers the Chinese collection, its English counterpart, and the processing record. Carry those edits through without asking again; contributor reactions require authorization for that external action.

## Retrieve and assess evidence

Fetch all pages of comments. Use the recorded timestamp for incremental review, or fetch the full history when no checkpoint exists or a historical recheck is requested:

```bash
gh api 'repos/stackia/rtp2httpd/issues/5/comments?since=YYYY-MM-DDTHH:MM:SSZ' --paginate
gh api repos/stackia/rtp2httpd/issues/5/comments --paginate
```

Review reports and later corrections in context. Include returned edits to older comments rather than filtering solely by `created_at`. Classify by evidence rather than punctuation or keywords:

- A working-address report identifies an address/port with explicit successful use or relevant packet-capture fields and regional/ISP context. Confirm attribution before adding it.
- A failure report needs locality and channel context: one location's failure does not establish decommissioning. Preserve existing entries and flag uncertainty unless removal or inactive marking is authorized by the user.
- Questions, requests for addresses, configuration help, and discussion supply no new working address on their own. A mixed question/report can still contain usable evidence.

Validate address/port syntax and check the current collection for duplicates. Do not invent missing ports, cities, or ISP assignments, and do not probe private/operator networks to classify a report.

## Apply the requested update

Update `docs/reference/cn-fcc-collection.md` using the province → ISP grouping in the reference. Within each group, list addresses without city annotations before city-specific entries. Extend an existing entry's supported locality when appropriate rather than duplicating it. Keep source comment IDs, authors, and dates in the processing record for traceability.

After Chinese changes, use [translate-docs-zh-en](../translate-docs-zh-en/SKILL.md) for `docs/en/reference/cn-fcc-collection.md`. Check that address/port pairs and locality annotations agree across languages.

When contributor acknowledgment is authorized, add a rocket only to a comment actually used for an update and only if the current account has not already reacted:

```bash
gh api repos/stackia/rtp2httpd/issues/comments/<comment-id>/reactions -f content=rocket
```

Do not react to duplicate-only reports or general questions. If a mutation returns an uncertain result, inspect existing reactions before retrying.

## Completion and checkpoint

Report comments reviewed, addresses added/changed, and unresolved reports with source links. If nothing actionable was found, leave the collection unchanged.

For a completed sync, update `references/update-memory.md` with a concise result and the latest fully processed comment's `created_at` as `last_processed_comment_date`, without moving the checkpoint backward. Record any reviewed edits by comment ID and keep unresolved items explicitly pending; do not advance past work lost to a fetch or translation failure. A check-only run leaves this record unchanged.
