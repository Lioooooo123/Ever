# Changelog

## [Unreleased]

### Changed

- Reduced alternate-screen per-frame allocation churn roughly 9-18x by painting full-width layout rows as direct line references instead of recompositing every visible row through ANSI/grapheme segmentation on each frame.
