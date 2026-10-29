# Changelog

## v0.2.1 - 2026-10-29 (test build)

### Fixed
- Keep the daily work-detail panel open and preserve its scroll position after saving output or a day plan.

## v0.2.0 - 2026-10-29

### Added
- Add configurable work types with output units, linked time-entry categories, daily output, and monthly cycle goals.
- Show daily work efficiency, weekly plans and trends, and cycle progress against cumulative targets.
- Support custom monthly cycle start days, weekly work schedules, and one-off daily adjustments.
- Let users retain the complete current cycle or 1–365 days of time entries, with separate 31/90/180/365-day daily summaries.

### Improved
- Organize settings into tabs and make the work dashboard more compact for multiple projects.
- Preserve an older 30-day retention setting as complete-cycle retention when upgrading.

### Security and reliability
- Limit desktop note windows to their own note, restrict Tauri window permissions, and add a content security policy.
- Sanitize dragged rich text, save pending notes before exit, and keep the app open when saving fails.
- Patch audited dependencies and pin GitHub Actions to commit hashes.

## v0.1.15 - 2026-10-29 (test build)

### Fixed
- Wait for pending app and desktop note saves before closing; keep the app open if a save fails.
- Sanitize rich text dropped into notes as well as pasted content.

### Security
- Enable a restrictive desktop content security policy and separate main and note window permissions.
- Pin GitHub Actions to audited commit hashes.
- Include the dependency updates from the preceding security audit.

## v0.1.11 - 2026-10-29

### Added
- Combined daily totals and weekly or monthly category trends in one time dashboard, with bar and line chart options.
- Added customizable global shortcuts for quick time tracking and creating desktop notes.

### Fixed
- Improved mini bar edge hiding in virtual displays.
- The time-tracking shortcut now starts on the first press, stops and saves on the second, and starts a new timer on the third.

## v0.1.10 - 2026-10-29

### Added
- Added a configurable time-entry retention period of 7, 15, 25, or 30 days.
- New databases default to 30 days. Existing databases keep their records until the user chooses a retention period.
- Show the number of older records before applying a retention period and ask for confirmation before deleting them.

## v0.1.9 - 2026-08-04

### Security
- Overrode PostCSS to version 8.5.23, resolving Dependabot alerts GHSA-r28c-9q8g-f849 and GHSA-fxqj-rqcc-2cmp.


## v0.1.8 - 2026-08-03

### Removed
- Removed the unused todo/schedule and Pomodoro features, including their menus, tray actions, local APIs, storage commands, and notification dependency.

### Changed
- Simplified the product to local time entries and smart sticky notes.

## v0.1.4 - 2026-07-20

### Fixed
- Created a fresh organization release tag after GitHub Actions was enabled, preserving the tag-triggered provenance chain.

## v0.1.3 - 2026-07-20

### Fixed
- Published a new patch tag because v0.1.2 has no corresponding GitHub Actions release in the organization repository.
- Prepared the organization repository for a clean GitHub Actions release.

## v0.1.2 - 2026-07-20

### Changed
- Published a clean organization release for secure-artifacts/Timepast2 with repository-specific provenance verification docs.

## v0.1.1 - 2026-07-19

### Fixed
- Updated the release workflow to publish installers through GitHub Actions with build provenance attestations.
- Bumped installer metadata for a clean trusted release tag.

## v0.1.0 - 2026-07-19

### Added
- Desktop sticky notes with rich text editing, colors, pinning, and collapsed mode.
- Mini bar mode with explicit always-on-top and edge auto-hide controls.
- Local time tracking, todos, and Pomodoro support.
- Windows installer publishing through GitHub Releases.

### Fixed
- Sanitized pasted spreadsheet HTML so notes no longer show raw Google Sheets markup.
- Preserved rich text formatting when syncing app notes and desktop notes.
- Fixed bold, highlight, and text color actions after selecting text.
- Prevented the mini bar from re-hiding to an old screen edge after being dragged back to the center.
