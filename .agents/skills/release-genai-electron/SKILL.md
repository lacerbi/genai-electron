---
name: release-genai-electron
description: Determine and execute a patch or minor genai-electron release through its release-preparation metadata and migration guide, pull request, CI, annotated tag, and GitHub release workflow. INVOKE ONLY when the user explicitly invokes $release-genai-electron or /release-genai-electron, names this skill, or directly asks to execute the repository release process. Do not invoke for general questions about versions, tags, pull requests, npm, or release planning.
---

# Release genai-electron

Release a completed, tested change through GitHub. Decide between a patch and
minor version unless the user explicitly specifies the version. Leave npm
publication to the user unless they separately and explicitly authorize it.

## Fixed repository conventions

- Use `main` as the base branch and `origin` as the remote.
- Accumulate fixes and features unreleased on `main` or a batch branch. Do not
  bump versions, open a batch release PR, tag, or publish until the user
  explicitly requests a release.
- Keep release work on the existing implementation branch when suitable. If
  starting from `main`, create `release/vX.Y.Z` before changing release
  metadata.
- Never commit release preparation directly to `main`.
- Prepare one release commit and PR after the implementation is complete.
- Use exactly one pull request for a release. Resolve and archive any completed
  root issue/plan records in that release-preparation commit and PR. Never open
  a follow-up pull request solely for post-release archival.
- Update all current-version surfaces: `package.json`, the root package entries
  in `package-lock.json`, the README version/status line, the documentation
  index version and migration link, `src/index.ts`'s `@version`, and the
  current-status/release entry in `PROGRESS.md`.
- Add a migration guide under `genai-electron-docs/` for the release and link
  it from `genai-electron-docs/index.md`. Follow neighboring filename patterns,
  including patch components when needed to distinguish a patch-to-patch
  migration. Describe compatibility and adoption even when the release is
  backward-compatible.
- Use the release-preparation commit form `release: prepare vX.Y.Z` unless an
  existing release branch already uses a more descriptive `release:` subject.
  This repository does not require DCO sign-off.
- Merge pull requests with a merge commit, not squash or rebase.
- Use annotated tags named `vX.Y.Z`.
- Use a concise release/tag title such as `vX.Y.Z: Release Theme`, following the
  punctuation and capitalization of the most recent releases.
- Curate release notes around `Highlights`, compatibility or migration,
  `Validation`, and the npm-publication handoff. Add release-specific sections
  when they materially help adopters.
- Require every GitHub check to pass before merging.
- Treat npm publication as a manual maintainer handoff by default.

## Safety and resumption

- Honor a narrower user request. If the user asks only for version judgment,
  stop after reporting the decision.
- Inspect live Git, GitHub, and release state before every mutation. Stable
  conventions are encoded here; branch, PR, tag, release, CI, and npm state are
  not.
- Preserve unrelated work. Stop and ask if the worktree contains changes that
  are not clearly part of the release.
- Treat new root `ISSUE*.md` files as proposals: read them and confirm with the
  user before incorporating them into the release.
- Require the implementation to be release-ready and committed before adding
  release preparation. Do not absorb unfinished feature work into this
  workflow.
- Resume verified completed steps instead of repeating them.
- Never force-push, move an existing tag, overwrite a release, or merge around
  failed or pending checks.
- Delete only the exact merged release branch, and only after verifying it is
  contained in `main`.
- Do not download large model/binary artifacts or run hardware-specific live
  smoke tests solely because this is a release. Run them only when justified by
  the changes and authorized when they are costly or invasive.
- Do not infer a major release. If the changes appear breaking and the user did
  not explicitly choose the target version, stop and ask.

## 1. Establish release state

Read `AGENTS.md`, `README.md`, `PROGRESS.md`, the documentation index, and the
relevant design or migration documents. Refresh remote state before making any
version or branch decision:

```text
git fetch --prune --tags origin
```

Then inspect the worktree, remote, latest version tag and GitHub release,
commits since that tag, current package and documentation versions, current
branch, upstream synchronization, root issue proposals, and any open PR from
the branch.

Compare the latest tag with `package.json`, both root-version fields in
`package-lock.json`, the README, documentation index, and `src/index.ts`.
Investigate mismatches before proceeding, and do not bump again when the
intended target is already present. Check whether a prior GitHub release still
awaits npm publication when that would affect the requested release.

If the clean worktree is on `main`, create `release/vX.Y.Z` after selecting the
target. Reuse a suitable existing non-`main` branch when it already contains
the release changes.

## 2. Select patch or minor

Judge the highest-impact change since the latest release:

- Choose **patch** for bug fixes, regressions, documentation corrections,
  dependency or security maintenance, binary-pin compatibility refreshes, and
  internal changes that add no public capability.
- Choose **minor** for a new public API, exported type, manager capability,
  configuration field, lifecycle event, response field, supported model
  behavior, or other backward-compatible user-facing capability.
- Choose **minor** when a correctness fix necessarily introduces public API.
  Version 0.16.0 is a precedent: context correctness work added public sizing
  fields, readiness state, and lifecycle reporting.
- Choose minor when a release contains both patch and minor changes.

Increment from the latest released version. State the target and a one-sentence
rationale before editing. Follow an explicitly requested patch or minor target
unless it conflicts with existing repository state. Never infer a major bump;
stop and ask if the changes appear to require one.

## 3. Prepare release metadata and migration

Update the current version in:

- `package.json`: top-level `version`
- `package-lock.json`: top-level `version`
- `package-lock.json`: `packages[""].version`
- `README.md`: version and concise production-ready theme
- `src/index.ts`: package `@version`
- `genai-electron-docs/index.md`: version/theme and newest migration link

Convert the `PROGRESS.md` `Unreleased` section into a dated `vX.Y.Z` entry,
update the current build status, and record the release-candidate branch and
remaining release steps. Add the migration guide using the previous guide as a
structural reference. Explain public API changes, compatibility, required
consumer actions, the pre-1.0 dependency-range consequence when relevant, and
verification or rollback guidance warranted by the change.

Close any root issue/plan records completed by the release: set their resolved
or complete status with the target date/version, tick acceptance and tracking
items, add the required resolution text, move them to the repository's
established archive under `docs/dev/`, and update references. Describe the
target release honestly; do not claim that GitHub or npm publication has
already occurred. Include these changes in the same release-preparation commit
and PR.

Keep implementation changes out of the release-preparation edit. Confirm every
current-version surface contains the target, stale current-version text is
gone from those locations, links resolve, and the diff contains no unrelated
edits. Do not rewrite historical release entries or old migration guides.

## 4. Run release gates

Format the release files, inspect any formatter changes, then run every
blocking local check:

```text
npm run format
npm run prepublishOnly
npm run lint
npm run format:check
npm audit --omit=dev --audit-level=high
npm pack --dry-run
git diff --check
```

Inspect the diff immediately after formatting and stop if it introduces
unrelated changes. Require all checks to pass. Record actual suite/test counts,
lint errors and warnings, audit results, and dry-run package version/file count
for the PR, `PROGRESS.md`, and release notes. Run
`npm audit --audit-level=high` informationally when useful; the production-only
audit is the blocking security gate.

Run additional focused, integration, example-app, packed-artifact, or live
hardware validation only when justified by the release changes. Never claim a
check that was not actually run.

## 5. Commit and push

Confirm the implementation commits already on the branch are intended for the
release. Stage only the reviewed release-preparation files and commit them
separately:

```text
git add <reviewed release files>
git commit -m "release: prepare vX.Y.Z"
git push -u origin HEAD
```

Verify the commit contents and upstream synchronization.

## 6. Create or reuse the pull request

Check for an open PR from the branch before creating one. Reuse it when present.
Otherwise create a PR targeting `main` with:

- A title such as `release: vX.Y.Z: concise theme`
- A concise summary of implementation and release preparation
- Compatibility and migration guidance with the guide path
- Any issue/plan resolution and archival included in the release
- Actual local verification results
- Any justified platform-specific or live-smoke results

Capture its number and URL.

## 7. Wait for green CI and merge

Monitor `gh pr checks`. Expect the Node 22 test matrix on Ubuntu, Windows, and
macOS, code quality, production security audit, and package validation, but
report the checks that actually run instead of hard-coding a count.

Keep the user updated while jobs are pending. Investigate and fix any failure,
rerun relevant local checks, commit the scoped fix, push, and wait for
replacement CI. Do not merge until every required check is green.

Confirm that any completed release issue/plan records are already resolved and
archived in this PR. Do not merge with the intention of opening a separate
archival PR afterward.

Merge with `gh pr merge <PR> --merge`. Verify the PR state is `MERGED` and
record the exact release merge commit SHA for synchronization and tagging.

## 8. Synchronize main and remove the branch

Run:

```text
git switch main
git pull --ff-only
```

Verify `main` contains the merge, reports the target version across all
current-version surfaces, matches `origin/main`, and has a clean worktree.
Do not substitute a later `main` HEAD for the recorded release merge SHA if
another PR merges before tagging.
Verify the release branch is an ancestor, delete that exact branch locally
with `git branch -d`, and delete it from `origin` if it still exists. Never
delete `main`.

## 9. Create and push the annotated tag

Check local and remote tag state. Stop if `vX.Y.Z` exists unless it already
points to the verified release commit and the workflow is resuming. Refresh
remote tags again immediately before creating the tag:

```text
git fetch --prune --tags origin
```

Create and verify:

```text
git tag -a vX.Y.Z -m "vX.Y.Z: concise release theme" <release-merge-sha>
git push origin vX.Y.Z
```

Verify the recorded merge SHA is contained in `origin/main`, its package
version is the target, and the peeled tag commit equals that exact SHA before
pushing. Push only the exact tag. Never force or move a published version tag.

## 10. Publish the GitHub release

Create a non-draft, non-prerelease release with `gh release create`,
`--verify-tag`, and the same title as the annotated tag. Curate notes in this
shape:

```markdown
## Highlights

- Describe user-visible changes and important correctness guarantees.

## Compatibility and adoption

Describe compatibility, consumer actions, and the tagged migration-guide link.

## Validation

- Summarize the actual green CI matrix.
- Summarize local tests, lint, formatting, audit, build, and package validation.

## npm publication

The npm package is published separately by the maintainer after this GitHub Release.
```

Replace or supplement `Compatibility and adoption` with `Migration` or other
release-specific sections when clearer. Verify the release tag, title,
publication time, URL, and draft/prerelease flags. If the tag was published but
release creation failed, preserve the tag and retry only release creation.

## 11. Hand off npm publication

Do not run `npm publish` by default. Tell the user the GitHub release is
complete and npm publication remains; `prepublishOnly` will rerun its guarded
clean build and tests during publication. After the user confirms publication,
optionally verify it with `npm view genai-electron@X.Y.Z version`.

Only publish to npm when the user separately and explicitly authorizes that
external action and npm authentication is available.

Do not edit archived release records or open another pull request merely to
record later npm publication; report and verify that external state in the
release handoff.

## 12. Report completion

Report the version and classification, PR and release URLs, merge commit,
annotated tag, migration guide, branch cleanup, clean synchronized `main`,
local and CI verification, npm publication status or handoff, and confirmation
that release records were archived in the single release PR.
