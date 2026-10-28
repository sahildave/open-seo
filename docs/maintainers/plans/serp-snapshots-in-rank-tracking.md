# Plan: show browser-collected SERP snapshots in Rank tracking

Branch: `feat/serp-snapshots-rank-tracking` (cut from `main` at `59e1b890`).

## Implementation status (2026-10-28)

Implemented in `codex/serp-snapshots-rank-tracking`, based on this plan's commit. Deployment and live-data verification remain owner steps below.

- HTTP and MCP ingest mirror stored captures into manual configs and completed daily runs. Both return `inserted` and `mirror` (`configsTouched`, `runsWritten`, `snapshotsSkipped`). Raw SERP captures remain append-only; the rank history mirror is idempotent.
- Daily runs and their positions are written atomically. Later same-day captures update positions, URLs and features. Capture timestamps use the existing provider-specific rank-history format.
- Captured depth rounds up to the next ten, matching the existing config form's validation (for example, position 15 requires depth 20).
- The existing config unique key excludes language. The mirror retains the existing config's language (or the earliest capture's language when creating one), leaves other languages in SERP storage, and reports them in `snapshotsSkipped`.
- The cache ingest script is included, with mirror-result printing. No schema migration, plugin version change, UI change or deployment was needed.
- Real SQLite tests cover daily mappings, backfill, repeated ingest, newer captures and domain/language guards. Removing snapshot conflict handling made the idempotency test fail on the intended unique constraint; restoring it passed.

Validation: the full suite passed (1,552 tests, one skipped). TypeScript, Knip, lint and plugin-skill sync passed. The root format check remains blocked by eight pre-existing Google SERP HTML/metadata fixture files; their raw contents were left unchanged. The new and changed files are formatted. Checks ran through the installed local binaries because pnpm could not fetch its pinned version in this environment. Snyk reported no findings in changed files; its 39 repository findings are outside this change.

## Goal

The Rank tracking screen shows the positions that the browser collector already captures, so the hand-written "ranking ladder" HTML reports are no longer needed.

Today the collector (EgoLite on the owner's Mac) scrapes Google and pushes each results page into `serp_snapshots` through `POST /api/serp-snapshots` or the `ingest_serp_snapshots` MCP tool. Rank tracking reads only `rank_tracking_configs`, `rank_tracking_keywords`, `rank_check_runs` and `rank_snapshots`, which only the DataForSEO rank-check workflow writes. Those tables are empty in production, so the screen shows nothing, even though 51 snapshots exist for the Gitsu and Shareling projects.

## Decisions (already made, do not reopen)

1. **No schema migration.** Mirror snapshots into the existing rank tracking tables. Migrations under `drizzle/` are one-way doors and need a gate.
2. **Mirror on ingest, and make it idempotent.** Every ingest re-mirrors all of the project's snapshots. The volume is about 20 keywords a week, so this stays cheap. It also backfills the 51 existing rows the first time anyone ingests. No separate backfill command.
3. **One run per config per collection day (UTC).** The collector runs once a day per product, and one ladder equals one day. Run id is deterministic: `serp-<configId>-<YYYY-MM-DD>`. Insert runs and rank snapshots with on-conflict-do-nothing (or update counts for the run), so re-ingesting never duplicates.
4. **Configs created by the mirror never call DataForSEO.** Set `scheduleInterval: "manual"`. The cron in `scheduledRankChecks.ts` must not pick them up. Confirm this by reading `getDueConfigsWithOrganization`.
5. **The project's domain is the tracked domain.** If `projects.domain` is null, skip the mirror for that project. `serp_snapshots.our_position` is already computed against it.

## Mapping

| Rank tracking                           | From `serp_snapshots`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rank_tracking_configs` (get or create) | `project_id`, `domain = projects.domain`, `location_code`, `language_code`, `location_name = null`, `devices` = `desktop`, `mobile` or `both` from the devices seen, `serp_depth` = deepest organic position seen (at least 10), `schedule_interval = "manual"`. Reuse `getConfigByProjectDomainLocation` and `createConfig`. Widen `devices` if a new device appears.                                                                                                                                                     |
| `rank_tracking_keywords` (upsert)       | `keyword`, lowercased the same way `addKeywordsToConfig` does. Reuse that function.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rank_check_runs`                       | `id = serp-<configId>-<day>`, `status = "completed"`, `keywords_total` = `keywords_checked` = distinct keywords that day, `is_subset_run` = fewer than the config's keyword count, `started_at` = earliest `collected_at` that day, `completed_at` = latest.                                                                                                                                                                                                                                                               |
| `rank_snapshots`                        | `run_id`, `tracking_keyword_id`, `keyword`, `device`, `position = our_position`, `url` = the URL of our best organic result (same host rule as `findOurPosition` in `SerpSnapshotService.ts`), `checked_at = collected_at`, `serp_features` = JSON array using DataForSEO's item type names (see `src/server/lib/dataforseo/serp.ts`): `organic` always, `people_also_ask` if `paa` is non-empty, `video` if `videos` is non-empty, `ai_overview` if `ai_overview.present`. Null when empty, matching `rankCheckPaths.ts`. |

If two snapshots exist for the same keyword, device and day, keep the latest.

## Where the code goes

- `src/server/features/serp-snapshots/services/SerpSnapshotService.ts`: after `insertMany`, call a new `mirrorToRankTracking(project)`. Keep it in this service, or in a sibling file in the same feature folder if it is over ~80 lines. Follow AGENTS.md: service → repository, no new abstraction layers.
- `src/server/features/serp-snapshots/repositories/SerpSnapshotRepository.ts`: add a query for all snapshots of a project (only the columns the mapping needs).
- Rank tracking repositories: add an insert for a completed run plus its snapshots with on-conflict handling, if none exists. Must work on both D1 (SQLite) and Postgres. See `docs/maintainers/review-guidelines.md` on dual-dialect persistence.
- Both ingest entry points already call `SerpSnapshotService.ingest`, so the HTTP route and the MCP tool get the mirror with no further changes. Do not add an MCP tool, so no plugin version bump is needed.
- Return the mirror result from `ingest` (configs touched, runs written) so the ingest script can print it.

## Also land on this branch

- `scripts/ingest-serp-cache.ts` exists only uncommitted in `~/code/projects/open-seo-worktrees/gitsu-serp-ingest`. Copy it in unchanged, apart from printing the mirror result. Without it, captures after 15 Oct (Gitsu 22 Oct, all of Gitback's runs) never reach OpenSEO.

## UI

None expected. The rank tracking screen already renders configs, runs, history matrix and trend charts from these tables. Check two things and fix only if broken:

1. Keyword metrics columns (volume, difficulty, CPC) stay empty without DataForSEO. They must render as blank, not as an error.
2. The "Check now" button on a mirrored config would call DataForSEO. Leave it in place. Do not add a source flag (that would need a migration).

## Tests

Follow AGENTS.md and the `test-audit` skill. Test through `SerpSnapshotService.ingest` with real SQL evaluation, not ORM chain mocks. The existing `SerpSnapshotService.test.ts` shows the setup. Two tests are enough:

1. Ingesting snapshots from two days creates one config, the keywords, two completed runs and rank snapshots with the right position, URL and features.
2. Ingesting the same batch again leaves row counts unchanged (idempotency).

Demonstrate each: revert the on-conflict handling and show test 2 failing, then restore it.

## Checks

`pnpm run ci:check` and `pnpm run test:ci` pass. No deploy, no live data, no secrets: those steps are below and are for the owner.

## After merge (owner, not Codex)

1. Deploy: `pnpm deploy:selfhost`.
2. Push the newer captures: `pnpm tsx scripts/ingest-serp-cache.ts --project <id> --dir ~/.cache/gitsu-seo/2026-10-22`. The first push also backfills the 51 existing snapshots.
3. Open Rank tracking for Gitsu and Shareling, and compare the positions with the last ranking ladder report.
4. Stop writing ranking ladder reports once they match.

## Out of scope

- Competitor URLs per keyword, PAA text and AI Overview excerpts on the Rank tracking screen. They stay in `serp_snapshots` and in the `list_serp_snapshots` MCP tool's diffs.
- Keyword volume without DataForSEO.
- A Gitback project in OpenSEO. Only Gitsu and Shareling exist today.
