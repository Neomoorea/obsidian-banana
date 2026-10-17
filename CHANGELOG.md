# Banana Changelog

## 1.0.0

Initial release of Banana, a composable query-language search plugin for Obsidian. Includes structured metadata predicates, Boolean query composition, parser-level field aliases, source-aware rendered Markdown matching, Literal/Semantic/Both result provenance, literal-only filtering, contextual autocomplete, and a draggable, resizable search panel.

Final UI polish keeps Tab inside the search input when no completion is available, restores content-driven vertical sizing with a persistent width and optional height cap, and shows the literal-only count only when those matches are hidden. Tag predicates now carry source offsets for tags written as YAML frontmatter values, so opening a result can highlight the actual tag. The default pane geometry now delegates to Obsidian's native prompt sizing (matching Omnisearch), while custom widths remain persistent; legacy vertical caps are reset once. Previous-query restoration is opt-in by default, and existing installs are migrated away from the old auto-restore default so a stale query no longer fills the input on every open.

See `README.md` for syntax and behavior, and `NOTICE.md` for required upstream licensing and attribution.
