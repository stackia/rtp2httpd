---
name: sync-fcc-ip-docs
description: >
  Synchronize rtp2httpd FCC IP documentation from GitHub issue feedback. ALWAYS use this skill
  when the user asks to update FCC address docs, check new FCC IP reports, validate existing FCC
  entries, or process comments from https://github.com/stackia/rtp2httpd/issues/5.
argument-hint: "[check|sync|update] [optional issue/comment context]"
---

# Sync FCC IP Documentation

Use this skill to curate community-sourced FCC (Fast Channel Change) IP address reports for
rtp2httpd and keep the Chinese and English FCC documentation synchronized.

Before processing comments, read `references/update-memory.md` for the last processed checkpoint,
known document paths, formatting rules, and prior update history. Update that reference after each
run with the newest processed comment timestamp and a concise update record.

## Core Mission

1. Read comments from <https://github.com/stackia/rtp2httpd/issues/5>.
2. Identify actionable information: new working FCC IPs and credible non-working reports.
3. Update the Chinese FCC address summary document.
4. Use the `translate-docs-zh-en` skill to synchronize the English translation after Chinese doc changes.

## Step 1: Fetch and Read Issue Comments

Check `references/update-memory.md` for `last_processed_comment_date`.

```bash
# Incremental: only comments after the last processed date
gh api "repos/stackia/rtp2httpd/issues/5/comments?since=YYYY-MM-DDTHH:MM:SSZ" --paginate

# Full: when no checkpoint exists
gh api repos/stackia/rtp2httpd/issues/5/comments --paginate
```

- If a checkpoint exists, process only comments created after that timestamp.
- If no checkpoint exists, process all comments.
- Read comments chronologically because later comments may correct earlier ones.

## Step 2: Classify Each Comment

### Actionable: New FCC IP Report

- The user explicitly shares a new FCC IP address they discovered or successfully use.
- The user confirms an IP works for a specific region, ISP, or location.
- Look for IP addresses such as `10.x.x.x`, `172.x.x.x`, `192.168.x.x`, or public IPs with location context.
- Example: "我在北京联通发现了一个新的 FCC 地址：10.205.x.x".

### Potentially Actionable: FCC Failure Report

- The user definitively reports that a known FCC IP no longer works, has been decommissioned, or is unreachable.
- A single report is not enough to remove an entry. Flag it for review and ask before deleting.
- Multiple independent reports for the same IP provide stronger evidence, but still confirm before removal.

### Not Actionable: Questions or General Discussion

- Questions about whether an IP works, how to find IPs, configuration help, troubleshooting, thanks, or project discussion.
- Phrases such as "请问", "有没有", "能不能", "是否", and "怎么" usually indicate questions.
- A question mark (`?` or `？`) often means inquiry rather than report.

### Classification Rules

- Treat phrases such as "分享一下", "发现了", "可以用", "亲测可用", and "已确认" as report signals.
- If ambiguous, do not update the document.
- If a later comment contradicts an earlier one, note both and prioritize the most recent reliable information.

## Step 3: Read Existing Documentation

- Use the Chinese FCC summary document recorded in `references/update-memory.md`.
- Read the current document to understand existing regions, ISPs, IPs, and formatting.
- Check whether reported IPs are already documented before adding anything.

## Step 4: Update the Chinese Document

- Add newly reported working FCC IPs with region, ISP, and city/location information when available.
- Do not duplicate existing IPs.
- Maintain existing Markdown style and grouping.
- Organize entries by province, then ISP.
- Within the same province and ISP, list addresses without city annotations first, then addresses with city annotations.
- For non-working reports, ask before removing or marking inactive unless the user already gave explicit removal instructions.
- Add notes only when the document convention supports them and the uncertainty is important.

## Step 5: Acknowledge Contributors

For each comment whose IP was added to the document, add a rocket reaction:

```bash
gh api repos/stackia/rtp2httpd/issues/comments/{comment_id}/reactions -f content=rocket
```

- React only to comments actually used for document updates.
- Do not react to questions, discussions, or duplicate reports.
- If the reaction already exists from a previous run, skip it.

## Step 6: Summarize Changes

Prepare a concise summary listing:

1. Number of comments reviewed.
2. Number classified as actionable vs. non-actionable.
3. IPs added, removed, or flagged for review.
4. Source comment authors and dates for traceability.

## Step 7: Sync English Translation

After Chinese document changes are complete, use the `translate-docs-zh-en` skill to update the
corresponding English document. Provide the updated Chinese document path and the change summary so
the translation update can focus on modified sections.

## Quality Assurance

- Validate every IP address and port before adding it.
- Confirm regional and ISP attribution from source comments.
- Verify no still-working IPs were removed accidentally.
- Preserve document formatting and ordering.
- If no actionable updates exist, report that clearly and make no doc changes.

## Updating Sync Memory

After each run, update `references/update-memory.md` with:

- `last_processed_comment_date`: set to the `created_at` timestamp of the last processed comment.
- An update record noting what changed.

You may also record reusable classification lessons, known platform/port patterns, or stable
document conventions. Do not record temporary task state, speculation, or duplicate repo-level
instructions.
