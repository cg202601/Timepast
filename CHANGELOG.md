# Changelog

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
