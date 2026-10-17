# Banana

[![License](https://img.shields.io/github/license/Neomoorea/obsidian-banana)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/Neomoorea/obsidian-banana)](https://github.com/Neomoorea/obsidian-banana/releases/latest)
![Obsidian 1.13.3+](https://img.shields.io/badge/obsidian-1.13.3%2B-7c3aed?style=flat-square)

![Banana is Omnisearch on Steroids](banners/Banana_Omnisearch_on_Steroids.jpg)

Banana is a fork of [Omnisearch](https://github.com/scambier/obsidian-omnisearch), the acclaimed search plugin for Obsidian. It keeps the familiar MiniSearch-powered ranked search and adds a composable query language, Boolean logic, structured metadata and file filters, hierarchical tag-pattern matching, rendered-Markdown matching, explicit match provenance, and source-aware navigation; among other goodies.

Omnisearch is excellent at finding notes from a few words. Banana keeps that familiar search path, but lets you be much more precise when a query needs more than keywords: combine real tags with frontmatter properties, restrict text to a section or block, filter by file metadata, or negate and combine result sets with Boolean operators.

The query language doesn't rewrite your notes. Banana works with the Markdown and metadata already in your vault, and tells you whether a result came from direct text evidence, an interpreted query predicate, or both.

Banana is for people who want to find a note — and for people who want to interrogate their vault like it owes them money.

## 🍌 Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Query language](#query-language)
  - [Basic text and phrases](#basic-text-and-phrases)
  - [Boolean operators and precedence](#boolean-operators-and-precedence)
  - [Grouping, implicit AND, and exclusions](#grouping-implicit-and-and-exclusions)
  - [Field modifiers and values](#field-modifiers-and-values)
  - [Complete field reference](#complete-field-reference)
  - [Properties and typed comparisons](#properties-and-typed-comparisons)
  - [Tags and subtags](#tags-and-subtags)
  - [Rendered text, source offsets, and literal matching](#rendered-text-source-offsets-and-literal-matching)
  - [Escaping, normalisation, and diagnostics](#escaping-normalisation-and-diagnostics)
- [Features beyond the query language](#features-beyond-the-query-language)
- [API and URL scheme](#api-and-url-scheme)
- [Installation](#installation)
- [Development](#development)
- [Credits and license](#credits-and-license)

## 🍌 Features

![Banana features](banners/Banana_features_banner.jpg)

- **Keep the familiar search:** ordinary free-text queries continue to use Banana's inherited MiniSearch-backed ranking path.
- **Compose queries:** `AND`, `OR`, `NOT`, `XOR`, `NAND`, `NOR`, `XNOR`, parentheses, and implicit conjunction.
- **Search structured data:** filenames, folders, extensions, dates, sizes, frontmatter properties, tags, aliases, headings, tasks, links, backlinks, embeds, and more.
- **Query nested tags and substrings:** segment-aware `*`, `?`, and `**` patterns, with progressive matching as you type and an explicit exact-path mode.
- **Understand where a result came from:** results use three provenance labels — `Literal`, `Semantic`, and `Both`, depending on whether it's the result of a query or a matching string of characters.
- **Match what you see:** rendered-text checks can find visible phrases that cross common Markdown formatting and map matches back to source offsets.
- **Stay keyboard-first:** all the beloved Omnisearch shortcuts, plus contextual autocomplete, toggling literal-only results and resetting the window pane straight from your keyboard.
- **Other features beyond the query language:** including movable and resizable window, result count, and more.

## 🍌 Quick start

Open **Banana: Vault search** from Obsidian's Command Palette or sidebar icon, then try:

| Query | What it does |
| --- | --- |
| `machine learning` | Runs an ordinary ranked full-text search. |
| `"machine learning"` | Searches for the words together, in order, as a phrase. |
| `tag:#AI AND content:machine learning` | Finds notes with the actual `#AI` tag and a full-text match for `machine learning`. |
| `(tag:#AI OR tag:#CS) AND content:machine learning` | Groups the tag alternatives, then intersects them with the content search. |
| `property:status=active property:priority>=3` | Requires both frontmatter predicates to match. |
| `path:"Projects/AI Roadmap" ext:md` | Filters by vault-relative path and file extension. |
| `tag:#*/machine-learning` | Matches hierarchical tag paths whose second segment begins with `machine-learning`, including `#AI/machine-learning-project`. |
| `task:todo` | Finds notes with an unchecked task. |
| `literal:"tag:#AI"` | Searches for those characters without evaluating them as query syntax. |

## 🍌 Query language

Banana's query language combines ordinary text search with typed predicates and Boolean set operations. Ordinary queries remain on the established search path unless the query uses advanced syntax.

### Basic text and phrases

A run of ordinary words, such as `machine learning`, is treated as one text query and keeps the inherited tokeniser, relevance ranking, and matching behaviour. Put a phrase in double quotes to require its words to appear together and in order:

```text
machine learning
"machine learning"
```

Quoted phrases are normalised for case, Unicode compatibility, and whitespace. Common Markdown formatting is handled by a supplemental rendered-text check, so a visible phrase such as `convolutional neural network` can match source text written as `**convolutional** neural network`.

### Boolean operators and precedence

Textual operators are recognized when they are **standalone uppercase words**. Operators inside quoted strings are literal text. Lowercase `and`, `or`, and `not` are ordinary search text.

| Precedence (highest first) | Operators | Symbolic aliases |
| --- | --- | --- |
| Unary | `NOT` | `!` |
| AND level | `AND` | `&&`, `&` |
| AND level | `NAND` | `!&&`, `↑` |
| XOR level | `XOR` | `^` |
| XOR level | `XNOR` | `!^`, `↔` |
| OR level | `OR` | `||` |
| OR level | `NOR` | `!||`, `↓` |

Binary operators at the same precedence level are left-associative, including chained `XOR` and `XNOR`. `!` means unary `NOT`; it is not an alias for `NOR`. Use `!||` or `↓` for NOR.

The Boolean meanings are the usual ones:

- `A AND B`: both sides match.
- `A OR B`: either side matches; duplicate notes are de-duplicated.
- `A XOR B`: exactly one side matches.
- `A NAND B`: the complement of `A AND B`.
- `A NOR B`: the complement of `A OR B`.
- `A XNOR B`: both sides have the same truth value.
- `NOT A`: the complement of `A`.

These operations combine result sets over the currently indexed-file universe; they are not limited to the first few text results. Consequently, complement operations such as `NOT`, `NAND`, `NOR`, and `XNOR` can include notes that had no positive full-text hit.

Examples:

```text
tag:#AI OR tag:#CS AND content:"machine learning"
# Equivalent to: tag:#AI OR (tag:#CS AND content:"machine learning")

(tag:#AI OR tag:#CS) AND content:machine-learning

NOT (tag:#archived OR property:status=deleted)
tag:#AI XOR tag:#CS
```

### Grouping, implicit AND, and exclusions

Parentheses group subexpressions. Adjacent independent predicates imply `AND`, so these are equivalent:

```text
tag:#AI content:"machine learning"
tag:#AI AND content:"machine learning"
```

A consecutive free-text run stays a single text query: `machine learning` is not rewritten as `machine AND learning`.

A leading hyphen is retained as a legacy exclusion for a standalone term or predicate:

```text
meeting -draft
path:Projects -tag:#archived
```

In an advanced query, `-tag:#archived` is unary exclusion and therefore behaves like `NOT tag:#archived`. Hyphens inside dates, words, filenames, and paths are not Boolean operators.

### Field modifiers and values

A field predicate generally has the form `field:value`. Field names are case-insensitive. Unless a field has a special grammar, string matching is case-insensitive, Unicode NFKC-normalised, and whitespace-normalised.

For fields that support structured text matching, these forms are available:

| Form | Meaning | Example |
| --- | --- | --- |
| `field:value` | Normalised substring match by default; enum-like fields may use progressive-prefix matching while typing. | `title:roadmap` |
| `field:=value` | Exact normalised match, or exact-path mode for `tag:`. | `title:=AI Roadmap` |
| `field:^value` | Prefix match. | `title:^AI` |
| `field:~value` | Substring match explicitly. | `title:~road` |
| `field:pattern*` | Glob match where supported; `*` matches zero or more characters. | `file:*.md` |
| `field:pattern?` | Glob match where supported; `?` matches one character. | `file:Plan?.md` |

Not every field supports every modifier. The field reference below calls out important exceptions. For filenames, paths, folders, aliases, headings, tasks, links, embeds, and other glob-capable text fields, unescaped `*` and `?` are glob wildcards. Tag paths use their own segment-aware rules.

Quote values with spaces or operator-like characters when needed:

```text
file:"AI Roadmap.md"
path:"Projects/AI Roadmap"
heading:"Implementation notes"
literal:"tag:#machine-learning"
```

The title exact and prefix forms also support unquoted multiword values, for example `title:=AI Roadmap` and `title:^AI Road`.

Numeric and date fields use comparisons following the colon, such as `size:>1MB`, `modified:>=2026-01-01`, and `tagcount:>=2`. Frontmatter properties have their own comparison syntax; see [Properties and typed comparisons](#properties-and-typed-comparisons).

### Complete field reference

The table lists the built-in field names and aliases currently implemented by Banana. Examples use the default case-insensitive matching behaviour unless a modifier is shown.

| Field | Matches against | Examples and notes |
| --- | --- | --- |
| `title:` | Obsidian display title, or the filename without its extension when no display title is available. | `title:roadmap`, `title:=AI Roadmap`, `title:^AI`, `title:~road` |
| `file:` | Full filename, including extension. | `file:"AI Roadmap.md"`; `file:=README.md` for exact filename; `file:=md` is a convenience shorthand for an exact extension match. |
| `path:` | Vault-relative file path. | `path:"Projects/AI Roadmap"`, `path:^Projects/` |
| `folder:` | Vault-relative parent directory. | `folder:Projects`, `folder:=Archive` |
| `ext:` | File extension from Obsidian's file metadata; dot is optional. Progressive by default while typing. | `ext:md`, `ext:=pdf`, `ext:^p`, `ext:~df`, `ext:m*` |
| `format:` | Logical extension class: `markdown`, `pdf`, `office`, `image`, `canvas`, `text`, or `other`. | `format:mark`, `format:=markdown`, `format:office` |
| `type:` | Broad file category: `note`, `document`, `image`, `canvas`, or `other`. | `type:no`, `type:=document` |
| `size:` | File size from Obsidian file stats. Numeric comparisons accept `B`, `KB`/`KiB`, `MB`/`MiB`, and `GB`/`GiB`; units use powers of 1024. | `size:>1MB`, `size:<=500KiB` |
| `words:` / `wordcount:` | Whitespace-delimited word count of cached indexed content. This is a simple token count, not linguistic analysis. | `words:>1000`, `wordcount:<=500` |
| `created:` | Filesystem creation time (`TFile.stat.ctime`), not a note-authored date. | `created:>=2026-01-01`, `created:<2025-12-31` |
| `modified:` | Filesystem modification time (`TFile.stat.mtime`). Date-only equality compares the UTC calendar date. | `modified:>=2026-01-01`, `modified:<2026-10-01` |
| `tag:` | The predicate checks actual tags from Obsidian's cached metadata. Separately, Banana searches for the query's literal spelling in note text; that match is labelled `Literal`, not mistaken for a real tag. | `tag:#work`, `tag:#proj*/B`, `tag:=work` |
| `tagcount:` | Count of unique actual tag paths on a note. | `tagcount:>=2`, `tagcount:=0` |
| `property:` | A frontmatter property: existence, value comparison, or string substring. | `property:status`, `property:status=active`, `property:priority>=3`, `property:aliases~="research"` |
| `alias:` | Frontmatter `aliases` or `alias` values. | `alias:"AI Plan"`, `alias:^Project` |
| `content:` | Semantic predicate over indexed note source. Unquoted values use the indexed text path; a quoted phrase such as `content:"machine learning"` must appear contiguously in the raw Markdown source (case/Unicode/whitespace normalisation applies), and does not bridge formatting markers. | `content:AI`, `content:"machine learning"` |
| `heading:` | Heading text from Obsidian's cached metadata. | `heading:architecture`, `heading:^API`, `heading:=Overview` |
| `section:` | Rendered text in one Markdown heading section at a time. Frontmatter is excluded. A section continues until the next heading at the same or a higher level; a note without headings has one implicit section. | `section:architecture`; two `section:` predicates joined by `AND` must match the same section. |
| `block:` | Rendered text in one blank-line-delimited source block at a time. Frontmatter is excluded. | `block:"machine learning"`; two `block:` predicates joined by `AND` must match the same block. |
| `line:` | Individual lines of cached document text. | `line:TODO`, `line:^WARNING` |
| `task:` | Markdown task-list lines; understands task state words. | `task:todo`, `task:done`, `task:incomplete`, `task:complete`, `task:"review draft"` |
| `task-todo:` | Whether a note has any unchecked task lines. | `task-todo:true`, `task-todo:false`, `task-todo:t` |
| `task-done:` | Whether a note has any checked task lines. | `task-done:true`, `task-done:false`, `task-done:f` |
| `linksto:` / `outlinks:` | Actual outgoing links from Obsidian's cached link metadata, matching the target. | `linksto:"Project Brief"`, `outlinks:^Projects/` |
| `linkedby:` / `inlinks:` | Incoming links from Obsidian's resolved-link graph, matching the source path or basename. | `linkedby:"AI Roadmap"`, `inlinks:Projects/` |
| `embed:` | Actual embed targets from Obsidian's cached metadata. | `embed:Diagram`, `embed:="AI Roadmap"` |
| `linkcount:` | Count of unique outgoing link targets, including unresolved names where available. | `linkcount:>0`, `linkcount:=0` |
| `backlinkcount:` | Count of distinct source notes that link to this note. | `backlinkcount:>=3`, `backlinkcount:=0` |
| `taskcount:` | Number of Markdown task-list lines, checked and unchecked. | `taskcount:>2`, `taskcount:=0` |
| `contains:` | Contiguous substring in rendered body text, independently of frontmatter and metadata. | `contains:"machine learning"`, `contains:=Exact phrase` |
| `has:` | Presence of a metadata/content category. Supported categories: `tags`, `aliases`, `frontmatter`/`properties`, `headings`, `tasks`, `links`, `embeds`, and `content` (common singular aliases also work). | `has:tag`, `has:frontmatter`, `has:links` |
| `is:` | Computed file state: `empty`, `orphan`, `tagged`, `untagged`, `todo`, `done`, `note`, `attachment`, `linked`, or `unlinked`. | `is:todo`, `is:attachment`, `is:unlinked` |
| `empty:` | Whether the rendered body is empty. Frontmatter alone does not make the body non-empty. | `empty:true`, `empty:false` |
| `orphan:` | Whether the note has no incoming resolved links. This is about backlinks, not outgoing links. | `orphan:true`, `orphan:false` |
| `literal:` | Normalised character substring in cached indexed content, full path, or normalised title. It never evaluates query syntax inside the value. | `literal:"tag:#AI"`, `literal:"%%%"`, `literal:"C:\\Projects\\AI"` |

Additional notes:

- `format:office` currently covers `.docx` and `.xlsx`; `type:document` covers the supported PDF, Office, and plaintext extensions.
- The current `image` extension mapping includes `png`, `jpg`, `jpeg`, `webp`, and `gif`. Unknown extensions map to `other`.
- `is:note` means a Markdown file; `is:attachment` means a non-Markdown file. `is:orphan` and `orphan:true` both describe missing incoming resolved links, while `is:linked` means there is at least one incoming or outgoing link.
- Missing frontmatter properties do not match a `property:` predicate, including `!=`. See the typed comparison rules below.

### Properties and typed comparisons

`property:` reads Obsidian's cached frontmatter, not ordinary body text. A property name can be queried by itself to test existence:

```text
property:status
property:sta
property:status=acti
property:status="active"
property:priority>=3
property:due<2026-12-31
property:aliases~="research"
```

Property names and unquoted string values are prefix-aware while typing. For example, `property:sta` can match the `status` key, and `property:status=acti` can match a string value of `active`. **Quote a string value to request exact string equality**, such as `property:status="active"`.

Supported operators:

| Operator | Meaning |
| --- | --- |
| No comparison operator | Property exists. |
| `=` | Equals; string equality can be progressive for unquoted values, while quoted string values are exact. |
| `!=` | Not equal. For arrays, no element may equal the expected value. A missing property does not match. |
| `>` `>=` `<` `<=` | Typed ordering comparisons. Numeric and date-like values use normalised numeric comparisons; string ordering is lexicographic. |
| `~=` | Case-insensitive substring matching for string values. |

Property values preserve their types. A numeric `3` is not the same as the string `"3"`; booleans, numbers, dates, arrays, `null`, and empty values are handled according to the type exposed by Obsidian's metadata cache. Array equality/comparison is element-wise: a positive comparison matches when an element matches, while `!=` requires that no element matches.

### Tags and subtags

Banana incorporates hierarchical tag queries *à la* **[DAGtags](https://github.com/Neomoorea/obsidian-dagtags)**, adapted to this fork's progressive-prefix behaviour. It evaluates patterns against Obsidian's actual cached tag paths instead of generating a large query by expanding every pattern.

There are two related but importantly different forms:

- `tag:#AI` evaluates **actual tag metadata** as its semantic predicate. In parallel, Banana checks whether the note body contains the literal query spelling `tag:#AI`; that creates a `Literal` result even when the note has no such tag.
- `#AI` evaluates the bare-tag predicate and also supports literal matching of the searched spelling. Literal evidence never fabricates a tag in Obsidian metadata.
- `literal:"tag:#AI"` searches for the characters and never evaluates them as a tag predicate.
- While typing, `tag:` and `tag:#` quietly behave like `has:tag` so real-tag results can appear before the tag name is entered.

#### Tag pattern rules

- Tag matching is case-insensitive.
- By default, a literal segment is a **prefix** while typing: `tag:AI` can match `#AI`, `#AIproject`, and descendants such as `#AI/machine-learning`.
- `tag:=AI` requests an exact complete tag path, so it matches `#AI` but not `#AIproject`.
- `*` matches zero or more characters **inside one segment**; `?` matches one character inside one segment.
- `**` is special only when it is a complete segment. It matches zero or more complete path segments.
- `=` switches to exact-path behaviour; it is not itself a wildcard.
- An escaped `\*` is a literal asterisk in a tag segment.

Examples:

| Query | Matches | Does not match |
| --- | --- | --- |
| `tag:#*/AI` | `#CS/AI`, `#ML/AI`, `#ML/AIproject` | `#ML/LLM-AI`, deeper `#CS/AI/CNN` |
| `tag:=*/AI` | Exact paths `#CS/AI`, `#ML/AI` | `#CS/AIproject`, `#ML/AIproject`, `#ML/LLM-AI`, `#CS/AI/CNN` |
| `tag:#*/AI*` | `#CS/AI`, `#ML/AI`, `#CS/AIproject` | `#CS/LLM-AI`, `#CS/AI/CNN` |
| `tag:#*/AIproject` | A second segment beginning with `AIproject`, such as `#CS/AIproject` | `#CS/AI`, `#CS/LLM-AI` |
| `tag:#*/AI/**` | B-prefixed second segments and their descendants, such as `#CS/AI/CNN` | Paths without a AI-prefixed second segment |
| `tag:#**/AI` | A AI-prefixed segment at any depth | Descendants below the matched segment unless `/**` is added |
| `tag:#**/AI/**` | AI-prefixed segments at any depth and their descendants | Paths with no AI-prefixed segment |
| `tag:#proj*/AI` | Paths such as `#project/AI` and `#projects/AI` | Paths where the first segment does not start with `proj` |

### Rendered text, source offsets, and literal matching

Markdown source and the text a reader sees are not always the same string. Banana includes a cached rendered-text projection for verification and source-offset mapping:

- `contains:` checks a contiguous phrase in rendered body text. Unlike `content:"..."`, it may match a phrase whose visible words are separated by Markdown formatting.
- `block:` searches within one blank-line-delimited source block at a time.
- `section:` searches within one heading-delimited section at a time.
- Common inline Markdown markers are ignored when checking visible phrase continuity, so a query for `"convolutional neural network"` can match `**convolutional** neural network`.
- Markdown-escaped punctuation is unescaped in rendered matching, so `%%%` can match source written as `\%\%\%`.
- When a source span is available, selecting a result can navigate to the relevant source location and highlight it.

`literal:` is for cases where the source characters themselves matter. It performs a normalised character-substring search and does not evaluate nested syntax. In addition, Banana runs a literal-source check for ordinary text queries and for the complete spelling of every advanced query. This is intentional: if a note contains `section:AI` as an example of query syntax, searching for `section:AI` can find it as `Literal`, even though the same query also has a semantic interpretation. Query spelling is never silently rewritten inside the note. This literal-source check is not interchangeable with rendered-text search.

`block:` and `section:` retain scope evidence during Boolean evaluation. For example, `block:alpha AND block:beta` only matches if both terms occur in the same block; the equivalent applies to `section:` within a single heading section. Combining a scoped text predicate with a file-level predicate, such as `block:LLM AND tag:#AI`, combines the local text evidence with the note's metadata.

### Escaping, normalisation, and diagnostics

- Text filters are case-insensitive and normalise Unicode with NFKC and collapse runs of whitespace, unless a field says otherwise.
- Inside quoted strings, `\"` escapes a quote and `\\` escapes a backslash. Outside quotes, a backslash can escape supported syntax characters.
- In glob patterns, `\*` and `\?` mean literal `*` and `?`. An escaped wildcard remains literal even when another wildcard in the same pattern is active.
- Operators inside quoted strings are text, and operator words must be uppercase and standalone to be recognised.
- A malformed advanced query does **not** silently fall back to a plain text search. Unknown fields, unmatched parentheses, missing Boolean operands, unterminated quotes, invalid completed tag patterns, unsupported completed enum values, and over-complex input yield a diagnostic and no results.
- Diagnostics are delayed until one second without typing, so incomplete input does not yell at you mid-keystroke. Empty known-field values such as `title:`, `path:`, `format:`, `has:`, and `property:status=` remain quiet editing states and do not leave stale results on screen.
- The parser limits a query to 512 tokens and 64 levels of parenthesis nesting.

## 🍌 Features beyond the query language

Banana adds several workflow and result-inspection improvements on top of the inherited Omnisearch experience.

### Result provenance

Results expose exactly three provenance labels:

- **Literal** — the note was found through direct text evidence, including ordinary full-text searches and literal occurrences of query syntax.
- **Semantic** — an interpreted field, tag, property, or other structured predicate matched.
- **Both** — the same note has both literal and semantic evidence.

Ordinary text search is literal evidence, and semantic evidence means that a parsed predicate matched. For `machine learning OR tag:#AI`, a note can be `Both` when its text matches and it has the real `AI` tag. A note that only contains the characters `tag:#AI` is `Literal`, not a semantic tag match. If a note both contains that spelling and has the real tag, it is `Both`.

The literal-only visibility control hides only `Literal` results that have no semantic evidence. `Both` results remain visible. Use **Ctrl/Cmd+Shift+L** to toggle this view; the footer labels the action `to hide literal-only matches` or `to show literal-only matches`.

### More useful navigation and search-window controls

- When at least one result is displayed, a unique-result count appears at the right side of the search input. The count of hidden literal-only results appears when literal-only results are hidden.
- Drag the bottom shortcut area to move the search window. Drag an edge or corner to resize it; the default height fits the current content, while a height explicitly chosen by dragging acts as a cap. A custom width is preserved independently. Position and custom geometry persist between openings. **Reset window** (**Ctrl/Cmd+Shift+C**) restores the default position and sizing.
- Use **Ctrl/Cmd+Shift+L** to hide or show literal-only matches.
- By default, Banana opens with an empty query. Enable **Settings → Behavior → Show previous query results** if you want it to rerun the previous query automatically.
- Selecting a result can navigate to a matched task, heading, property source, a real tag in frontmatter, or a rendered-text span when source-offset evidence is available.
- A contextual grey ghost-text suggestion can complete field names, tags, property keys/values, enum values, or the final token of indexed text. Press **Tab** to accept a suggestion.

### Configurable field aliases

Custom field aliases can shorten frequently used predicates — for example, mapping `pt` to `property` and then querying `pt:status=active`. Aliases are resolved by the parser rather than by rewriting note text; literal text is left alone. Built-in field names cannot be overridden, targets must be canonical fields, and alias chaining is intentionally one hop.

### Indexing and inherited document search

Banana continues to use the existing local MiniSearch index for ordinary ranked text queries. Structured predicates use Obsidian's file metadata, cached frontmatter, tag metadata, and resolved-link graph as appropriate. Query caches are refreshed through file and metadata lifecycle events.

As with Omnisearch, indexing of PDFs, images, and some Office documents may require the [Text Extractor plugin](https://github.com/scambier/obsidian-text-extractor), and extraction is not guaranteed for every file. See [Images, PDFs, and non-text documents](Docs/Images%2C%20PDFs%2C%20and%20non-text%20documents.md).

## 🍌 API and URL scheme

Banana provides an Obsidian URL scheme, an in-process JavaScript API, and an optional local HTTP endpoint for integrations. See the full [Public API & URL Scheme documentation](Docs/Public%20API%20%26%20URL%20Scheme.md).

- **URL scheme:** `obsidian://banana?query=tag%3A%23work%20AND%20content%3Ameeting`
- **In-Obsidian API:** the `banana` object exposes `search(query)`, `refreshIndex()`, and indexing callbacks.
- **HTTP endpoint:** `GET http://localhost:51361/search?q=...`; the HTTP server is disabled by default, must be enabled in settings, and is available only on desktop. It binds to localhost and is stopped when Obsidian closes.

The fork retains legacy Omnisearch protocol/API aliases for compatibility, while `banana` is the canonical identity for the plugin's own URL scheme and API.

## 🍌 Installation

Banana requires **Obsidian 1.13.3 or later**.

### Option A — with BRAT

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's Community Plugins browser.
2. In BRAT, choose **Add Beta plugin**, then enter `Neomoorea/obsidian-banana`.
3. Enable Banana under **Settings → Community plugins**.

### Option B — manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest GitHub release](https://github.com/Neomoorea/obsidian-banana/releases/latest).
2. Create the folder `.obsidian/plugins/banana/` inside your vault, and place those three files in it.
3. In Obsidian, go to **Settings → Community plugins**, click **Reload
   plugins** (or restart Obsidian), then enable **Banana**.

### Option C — build from source

Clone or download the repository, then run these commands from its root:

```sh
pnpm install
pnpm test
pnpm check
pnpm build
```

A successful production build creates `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`. Copy those three files directly into your vault's `.obsidian/plugins/banana/` folder.

For development, `pnpm dev` runs the configured build in watch mode.

## 🍌 Development

Requirements: a Node.js version compatible with the current toolchain, pnpm, and Obsidian type definitions supplied through the project dependencies.

```sh
pnpm install
pnpm test       # Vitest unit tests
pnpm check      # TypeScript and Svelte diagnostics
pnpm lint       # ESLint
pnpm build      # type-check, bundle, and verify output files
pnpm dev        # watch build
```

The production bundle is written directly to `dist/`. The build's verification step checks that the entry point, manifest, and stylesheet exist and that the plugin identity and version match the source metadata.

## 🍌 Credits and license

Banana is a fork of [Omnisearch](https://github.com/scambier/obsidian-omnisearch) and retains the upstream project's **GNU General Public License v3.0**. See [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md) for the license and attribution notices.
