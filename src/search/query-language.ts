import { hasUnescapedWildcard, globPatternMatches } from './glob'

/**
 * Query language for the Banana query fork.
 *
 * This module is intentionally independent of Obsidian so the lexer/parser and
 * tag-glob semantics can be unit-tested in Node/Vitest.
 */

export type BooleanOperator = 'AND' | 'OR' | 'XOR' | 'XNOR' | 'NAND' | 'NOR'
export type ComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~='
export type TitleMatchMode = 'substring' | 'exact' | 'prefix'
export type TextMatchMode = 'substring' | 'exact' | 'prefix' | 'glob'

export interface SourceSpan {
  start: number
  end: number
}

interface BaseNode extends SourceSpan {
  raw: string
}

export interface TextNode extends BaseNode {
  kind: 'text'
  value: string
}

/** A contiguous free-text run delegated to Banana as one ranked query. */
export interface TextQueryNode extends BaseNode {
  kind: 'textQuery'
  query: string
  phraseValues: string[]
}

export interface PhraseNode extends BaseNode {
  kind: 'phrase'
  value: string
}

export interface LiteralNode extends BaseNode {
  kind: 'literal'
  value: string
}

export interface FieldNode extends BaseNode {
  kind: 'field'
  field: string
  value: string
  comparison?: ComparisonOperator
  titleMode?: TitleMatchMode
  /** Matching mode shared by structured text fields. */
  matchMode?: TextMatchMode
  /** Original value spelling, retained so escaped glob tokens remain literal. */
  rawValue?: string
  /**
   * The raw wildcard pattern (modifier removed, escapes intact) when the value is
   * unquoted and has an active `*` or `?`. The match mode then decides only where
   * the pattern is anchored: `=` the whole value, `^` its start, `~` anywhere.
   */
  globPattern?: string
  /** Tag paths normally use progressive prefix semantics; `=` requests an exact path. */
  tagExact?: boolean
}

export interface PropertyNode extends BaseNode {
  kind: 'property'
  name: string
  comparison: 'exists' | ComparisonOperator
  value?: unknown
  rawValue?: string
}

export interface TagNode extends BaseNode {
  kind: 'tag'
  pattern: string
  bare: boolean
  literalNeedle: string
}

export interface NotNode extends BaseNode {
  kind: 'not'
  child: QueryNode
}

export interface BinaryNode extends BaseNode {
  kind: 'binary'
  operator: BooleanOperator
  left: QueryNode
  right: QueryNode
}

export type QueryNode =
  | TextNode
  | TextQueryNode
  | PhraseNode
  | LiteralNode
  | FieldNode
  | PropertyNode
  | TagNode
  | NotNode
  | BinaryNode

/**
 * Return original spellings of structured query leaves for independent literal
 * evidence checks. These spellings must not be mixed into Boolean AST evaluation:
 * a literal `tag:#x` mention cannot satisfy the semantic `tag:#x` predicate.
 */
export function collectLiteralSyntaxSpellings(node: QueryNode): string[] {
  switch (node.kind) {
    case 'field':
    case 'property':
    case 'literal':
    case 'tag':
      return [node.raw]
    case 'not':
      return collectLiteralSyntaxSpellings(node.child)
    case 'binary':
      return [...collectLiteralSyntaxSpellings(node.left), ...collectLiteralSyntaxSpellings(node.right)]
    default:
      return []
  }
}

export interface QueryDiagnostic {
  message: string
  start: number
  end: number
  severity: 'error' | 'warning'
}

export interface ParsedQueryLanguage {
  source: string
  root: QueryNode | null
  diagnostics: QueryDiagnostic[]
  isAdvanced: boolean
}

type LexemeKind = 'atom' | 'phrase' | 'operator' | 'lparen' | 'rparen' | 'eof'
interface Lexeme extends SourceSpan {
  kind: LexemeKind
  raw: string
  value?: string
  operator?: string
}

export interface FieldRegistryEntry {
  /** Authoritative source inspected by the evaluator. */
  source: string
  /** Syntactic value types accepted by this predicate. */
  valueTypes: readonly string[]
  /** Matching rule, including whether the value is interpreted as a pattern. */
  matching: string
  /** Supported comparison operators. */
  operators: readonly string[]
  /** Whether text matching is case-sensitive. */
  caseSensitive: boolean
  /** Behavior when the corresponding value is missing. */
  missing: string
  /** Semantics when the source value contains multiple values. */
  multivalue: string
  /** Files for which the source is meaningful. */
  appliesTo: string
  /** Whether existing metadata/indexes are sufficient. */
  indexing: string
  /** Approximate query cost. */
  performance: string
}

/**
 * Runtime field registry. Keep this synchronized with `matchesField` and the
 * query-language reference. The search engine validates names against it.
 */
export const FIELD_REGISTRY: Readonly<Record<string, FieldRegistryEntry>> = {
  title: { source: 'Obsidian displayTitle, otherwise file basename', valueTypes: ['string'], matching: 'case-insensitive substring by default; := exact; ^ prefix; ~ substring', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'unavailable title does not match', multivalue: 'one normalized title', appliesTo: 'all indexed files', indexing: 'existing index plus file metadata', performance: 'low' },
  file: { source: 'TFile.name including extension', valueTypes: ['string'], matching: 'case-insensitive substring by default; := exact; ^ prefix; ~ substring; * and ? glob', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'does not match', multivalue: 'single filename', appliesTo: 'all indexed files', indexing: 'vault file metadata', performance: 'low' },
  path: { source: 'vault-relative TFile.path', valueTypes: ['string'], matching: 'case-insensitive substring by default; := exact; ^ prefix; ~ substring; * and ? glob', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'does not match', multivalue: 'single path', appliesTo: 'all indexed files', indexing: 'vault file metadata', performance: 'low' },
  folder: { source: 'directory portion of TFile.path', valueTypes: ['string'], matching: 'case-insensitive substring by default; := exact; ^ prefix; ~ substring; * and ? glob', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'root-level files have an empty folder and do not match non-empty values', multivalue: 'single folder path', appliesTo: 'all indexed files', indexing: 'vault file metadata', performance: 'low' },
  ext: { source: 'TFile.extension', valueTypes: ['extension'], matching: 'progressive prefix by default while typing; := exact; ^ prefix; ~ substring; * and ? glob; dot optional', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'files without matching extension do not match', multivalue: 'space-separated alternatives', appliesTo: 'all indexed files', indexing: 'vault file metadata', performance: 'low' },
  format: { source: 'extension-to-format mapping', valueTypes: ['markdown', 'pdf', 'office', 'image', 'canvas', 'text', 'other'], matching: 'progressive prefix by default while typing; := exact; ^ prefix; ~ substring; * and ? glob', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'unrecognized extensions map to other', multivalue: 'space-separated alternatives', appliesTo: 'all indexed files', indexing: 'static extension map', performance: 'low' },
  type: { source: 'extension-to-category mapping', valueTypes: ['note', 'document', 'image', 'canvas', 'other'], matching: 'progressive prefix by default while typing; := exact; ^ prefix; ~ substring; * and ? glob', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'unrecognized extensions map to other', multivalue: 'space-separated alternatives', appliesTo: 'all indexed files', indexing: 'static extension map', performance: 'low' },
  size: { source: 'TFile.stat.size', valueTypes: ['number with optional B/KB/KiB/MB/MiB/GB/GiB'], matching: 'typed numeric comparison', operators: ['=', '!=', '>', '>=', '<', '<='], caseSensitive: false, missing: 'files without stats do not match', multivalue: 'single value', appliesTo: 'all indexed files', indexing: 'vault file metadata', performance: 'low' },
  words: { source: 'whitespace-delimited tokens in indexed content', valueTypes: ['number'], matching: 'typed numeric comparison', operators: ['=', '!=', '>', '>=', '<', '<='], caseSensitive: false, missing: 'missing content counts as zero words', multivalue: 'single count', appliesTo: 'files with indexed content', indexing: 'cached indexed content', performance: 'medium' },
  wordcount: { source: 'whitespace-delimited tokens in indexed content', valueTypes: ['number'], matching: 'same as words: typed numeric comparison', operators: ['=', '!=', '>', '>=', '<', '<='], caseSensitive: false, missing: 'missing content counts as zero words', multivalue: 'single count', appliesTo: 'files with indexed content', indexing: 'cached indexed content', performance: 'medium' },
  created: { source: 'TFile.stat.ctime (filesystem creation time)', valueTypes: ['date'], matching: 'date comparison; date-only equality compares UTC calendar day', operators: ['=', '!=', '>', '>=', '<', '<='], caseSensitive: false, missing: 'files without stats do not match', multivalue: 'single timestamp', appliesTo: 'all indexed files', indexing: 'vault file metadata; not note-authored date', performance: 'low' },
  modified: { source: 'TFile.stat.mtime (filesystem modification time)', valueTypes: ['date'], matching: 'date comparison; date-only equality compares UTC calendar day', operators: ['=', '!=', '>', '>=', '<', '<='], caseSensitive: false, missing: 'files without stats do not match', multivalue: 'single timestamp', appliesTo: 'all indexed files', indexing: 'vault file metadata', performance: 'low' },
  tag: { source: 'Obsidian CachedMetadata via getAllTags', valueTypes: ['tag path/glob'], matching: 'progressive segment-prefix matching by default; `=` exact complete path; * and ? stay within one segment; ** whole-segment globstar', operators: [':', ':='], caseSensitive: false, missing: 'no actual tags means no match', multivalue: 'any actual tag path may match', appliesTo: 'files with Obsidian tag metadata', indexing: 'cached metadata; invalidated on metadata/file lifecycle events', performance: 'medium' },
  tagcount: { source: 'unique tag paths from Obsidian CachedMetadata', valueTypes: ['number'], matching: 'typed numeric comparison', operators: ['=', '!=', '>', '>=', '<', '<='], caseSensitive: false, missing: 'no tags count as zero', multivalue: 'unique full tag paths', appliesTo: 'all indexed files', indexing: 'cached metadata', performance: 'medium' },
  property: { source: 'Obsidian frontmatter cache', valueTypes: ['string', 'number', 'boolean', 'date', 'array', 'null', 'empty'], matching: 'existence; typed equality/ordering; ~= case-insensitive substring', operators: ['exists', '=', '!=', '>', '>=', '<', '<=', '~='], caseSensitive: false, missing: 'missing property does not match, including !=; explicit null/empty values are distinct', multivalue: 'equality/comparison matches any array element; != means no element equals expected', appliesTo: 'files with frontmatter', indexing: 'cached frontmatter', performance: 'medium' },
  alias: { source: 'frontmatter aliases/alias', valueTypes: ['string'], matching: 'case-insensitive substring by default; := exact; ^ prefix; ~ substring; * and ? glob', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'no aliases means no match', multivalue: 'any alias may match', appliesTo: 'files with aliases', indexing: 'cached frontmatter', performance: 'low' },
  content: { source: 'Banana MiniSearch index for word queries; cached document text for punctuation-only queries', valueTypes: ['string'], matching: 'existing ranked full-text search', operators: [':'], caseSensitive: false, missing: 'no content match', multivalue: 'one document content', appliesTo: 'files with indexed text', indexing: 'existing MiniSearch index', performance: 'index-backed' },
  heading: { source: 'Obsidian CachedMetadata.headings', valueTypes: ['string'], matching: 'case-insensitive substring by default; := exact; ^ prefix; ~ substring; * and ? glob', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'no heading means no match', multivalue: 'any heading may match', appliesTo: 'files with heading metadata', indexing: 'cached metadata', performance: 'low' },
  section: { source: 'heading-delimited sections in cached Markdown source', valueTypes: ['string'], matching: 'searches one rendered section at a time; AND between section predicates requires a shared section', operators: [':', ':=', ':^', ':~'], caseSensitive: false, missing: 'files without matching section text do not match', multivalue: 'any section may match', appliesTo: 'Markdown-like indexed files', indexing: 'cached source and rendered-text projection', performance: 'medium' },
  block: { source: 'blank-line-delimited blocks in cached Markdown source', valueTypes: ['string'], matching: 'searches one rendered block at a time; AND between block predicates requires a shared block', operators: [':', ':=', ':^', ':~'], caseSensitive: false, missing: 'files without matching block text do not match', multivalue: 'any block may match', appliesTo: 'indexed text files', indexing: 'cached source and rendered-text projection', performance: 'medium' },
  line: { source: 'individual lines of cached document text', valueTypes: ['string'], matching: 'case-insensitive substring by default; := exact; ^ prefix; ~ substring; * and ? glob within a line', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'no matching line', multivalue: 'any line may match', appliesTo: 'files with indexed text', indexing: 'cached document text', performance: 'medium' },
  task: { source: 'Markdown task-list lines in cached text', valueTypes: ['string'], matching: 'todo/done state or substring by default; := exact; ^ prefix; ~ substring; * and ? glob within an actual task line', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'no matching task', multivalue: 'any task may match', appliesTo: 'files with Markdown-like text', indexing: 'cached document text', performance: 'medium' },
  'task-todo': { source: 'unchecked Markdown task-list lines', valueTypes: ['boolean'], matching: 'presence predicate; false means no unchecked tasks', operators: [':'], caseSensitive: false, missing: 'no tasks means false; explicit false tests absence', multivalue: 'any matching task', appliesTo: 'files with Markdown-like text', indexing: 'cached document text', performance: 'medium' },
  'task-done': { source: 'checked Markdown task-list lines', valueTypes: ['boolean'], matching: 'presence predicate; false means no checked tasks', operators: [':'], caseSensitive: false, missing: 'no tasks means false; explicit false tests absence', multivalue: 'any matching task', appliesTo: 'files with Markdown-like text', indexing: 'cached document text', performance: 'medium' },
  linksto: { source: 'Obsidian CachedMetadata.links resolved through metadataCache', valueTypes: ['link target'], matching: 'substring by default; := exact; ^ prefix; ~ substring; * and ? glob against resolved/unresolved target', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'no outgoing links means no match', multivalue: 'any outgoing link may match', appliesTo: 'files with link metadata', indexing: 'cached metadata and resolved link lookup', performance: 'medium' },
  outlinks: { source: 'outgoing targets from Obsidian CachedMetadata.links', valueTypes: ['link target'], matching: 'same matching behavior as linksto', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'no outgoing links means no match', multivalue: 'any outgoing link may match', appliesTo: 'files with link metadata', indexing: 'cached metadata and resolved link lookup', performance: 'medium' },
  linkedby: { source: 'metadataCache.resolvedLinks incoming edges', valueTypes: ['source path/title'], matching: 'substring by default; := exact; ^ prefix; ~ substring; * and ? glob against source path/title', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'no incoming links means no match', multivalue: 'any backlink source may match', appliesTo: 'files in Obsidian resolved-link map', indexing: 'Obsidian resolved link graph', performance: 'medium' },
  inlinks: { source: 'incoming source paths from metadataCache.resolvedLinks', valueTypes: ['source path/title'], matching: 'same matching behavior as linkedby', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'no incoming links means no match', multivalue: 'any backlink source may match', appliesTo: 'files in Obsidian resolved-link map', indexing: 'Obsidian resolved link graph', performance: 'medium' },
  embed: { source: 'Obsidian CachedMetadata.embeds resolved through metadataCache', valueTypes: ['embed target'], matching: 'substring by default; := exact; ^ prefix; ~ substring; * and ? glob against resolved/unresolved target', operators: [':', ':=', ':^', ':~', 'glob'], caseSensitive: false, missing: 'no embeds means no match', multivalue: 'any embed may match', appliesTo: 'files with embed metadata', indexing: 'cached metadata', performance: 'medium' },
  contains: { source: 'rendered body text in cached note content', valueTypes: ['string'], matching: 'contiguous rendered-text substring; verified by candidate index', operators: [':', ':=', ':^', ':~'], caseSensitive: false, missing: 'no rendered-text match', multivalue: 'one rendered body', appliesTo: 'files with indexed text', indexing: 'cached rendered-text candidate index', performance: 'index-backed' },
  is: { source: 'computed note/file state', valueTypes: ['empty', 'orphan', 'tagged', 'untagged', 'todo', 'done', 'note', 'attachment', 'linked', 'unlinked'], matching: 'state predicate, prefix-aware while typing', operators: [':'], caseSensitive: false, missing: 'unsupported completed state is a query diagnostic', multivalue: 'computed file state', appliesTo: 'all indexed files', indexing: 'cached metadata and content', performance: 'medium' },
  empty: { source: 'rendered body text', valueTypes: ['true', 'false'], matching: 'boolean predicate for an empty rendered body', operators: [':'], caseSensitive: false, missing: 'empty body is true', multivalue: 'single boolean', appliesTo: 'all indexed text files', indexing: 'cached rendered-text projection', performance: 'medium' },
  orphan: { source: 'resolved incoming-link graph', valueTypes: ['true', 'false'], matching: 'true when no other note links to this file', operators: [':'], caseSensitive: false, missing: 'no incoming links is true', multivalue: 'single boolean', appliesTo: 'files represented in Obsidian link graph', indexing: 'metadataCache.resolvedLinks', performance: 'medium' },
  linkcount: { source: 'outgoing links in CachedMetadata', valueTypes: ['number'], matching: 'typed numeric comparison of unique resolved/unresolved targets', operators: ['=', '!=', '>', '>=', '<', '<='], caseSensitive: false, missing: 'no outgoing links count as zero', multivalue: 'unique target count', appliesTo: 'all indexed files', indexing: 'cached metadata', performance: 'medium' },
  backlinkcount: { source: 'incoming source notes in metadataCache.resolvedLinks', valueTypes: ['number'], matching: 'typed numeric comparison of unique linking notes', operators: ['=', '!=', '>', '>=', '<', '<='], caseSensitive: false, missing: 'no backlinks count as zero', multivalue: 'unique source-note count', appliesTo: 'all indexed files', indexing: 'resolved link graph', performance: 'medium' },
  taskcount: { source: 'task-list lines in cached source', valueTypes: ['number'], matching: 'typed numeric comparison', operators: ['=', '!=', '>', '>=', '<', '<='], caseSensitive: false, missing: 'no tasks count as zero', multivalue: 'task-line count', appliesTo: 'indexed text files', indexing: 'cached source', performance: 'medium' },
  has: { source: 'frontmatter, tags, headings, tasks, links, embeds, or content cache', valueTypes: ['tags', 'aliases', 'frontmatter', 'headings', 'tasks', 'links', 'embeds', 'content'], matching: 'true when the requested category is present', operators: [':'], caseSensitive: false, missing: 'absent category is false', multivalue: 'presence of any item is sufficient', appliesTo: 'indexed files', indexing: 'Obsidian metadata and cached document text', performance: 'low' },
  literal: { source: 'cached indexed content, full path, and normalized title', valueTypes: ['string'], matching: 'case-insensitive normalized character substring; never parses embedded syntax', operators: [':'], caseSensitive: false, missing: 'no exact substring means no match', multivalue: 'one document body/path/title haystack', appliesTo: 'files with cached content/metadata', indexing: 'cached document text/context', performance: 'medium' },
}

const FIELD_NAMES = new Set(Object.keys(FIELD_REGISTRY).filter(field => field !== 'literal'))

/**
 * Text fields whose unquoted `=` and `^` values may span spaces, so that
 * `title:=AI Roadmap` means `title:="AI Roadmap"`. These hold natural-language
 * text. Fields that hold names or paths (`path:^Projects/ meeting` is a path prefix
 * followed by a search for `meeting`), enum, numeric, boolean and tag fields keep
 * single-word values. Quote a value to end it early.
 */
const MULTIWORD_FIELDS: ReadonlySet<string> = new Set([
  'title', 'alias', 'heading', 'section', 'block', 'line', 'task', 'contains',
])

/**
 * Default start-of-word patterns that are ordinary text although they look like
 * `word:`: any URL scheme and any Windows drive path. In a pattern `*` stands for
 * scheme-like characters (letters, digits, `+`, `.`, `-`) and `?` for one letter,
 * so `*://` cannot swallow the colon of a field prefix such as `title:https://`.
 */
export const DEFAULT_LITERAL_PREFIXES: readonly string[] = ['*://', '?:\\', '?:/']

export interface QueryLanguageOptions {
  /** User aliases from short names to built-in fields. */
  fieldAliases?: QueryFieldAliases
  /** Start-of-word patterns exempt from field parsing; see DEFAULT_LITERAL_PREFIXES. */
  literalPrefixes?: readonly string[]
}

function compileLiteralPrefixes(entries: readonly string[]): RegExp[] {
  const compiled: RegExp[] = []
  for (const entry of entries) {
    const pattern = entry.trim()
    if (!pattern) continue
    const source = [...pattern]
      .map(char => char === '*' ? '[a-z0-9+.-]*' : char === '?' ? '[a-z]' : char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('')
    compiled.push(new RegExp(`^${source}`, 'iu'))
  }
  return compiled
}

const isLiteralPrefixed = (value: string, exemptions: readonly RegExp[]): boolean =>
  exemptions.some(pattern => pattern.test(value))

export type QueryFieldAliases = Readonly<Record<string, string>>

function canonicalFieldName(field: string, aliases: QueryFieldAliases = {}): string {
  const normalized = field.toLocaleLowerCase()
  // Built-in names always win. Aliases are one-hop parser metadata, never text replacement.
  if (FIELD_NAMES.has(normalized)) return normalized
  const rawTarget = aliases[normalized]
  const target = typeof rawTarget === 'string' ? rawTarget.toLocaleLowerCase() : undefined
  return target && FIELD_NAMES.has(target) ? target : normalized
}

function isKnownFieldName(field: string, aliases: QueryFieldAliases = {}): boolean {
  return FIELD_NAMES.has(field.toLocaleLowerCase()) || canonicalFieldName(field, aliases) !== field.toLocaleLowerCase()
}

const SYMBOL_OPERATORS: ReadonlyArray<readonly [string, string]> = [
  ['!&&', 'NAND'],
  ['!||', 'NOR'],
  ['!^', 'XNOR'],
  ['&&', 'AND'],
  ['||', 'OR'],
  ['↑', 'NAND'],
  ['↓', 'NOR'],
  ['↔', 'XNOR'],
  ['&', 'AND'],
  ['^', 'XOR'],
]

/** Characters a backslash can escape. Keep `decodeValue` and glob.ts in step with this set. */
const ESCAPABLE_CHARACTERS = '"\\*:=^~()'

const isSpace = (char: string | undefined): boolean => !!char && /\s/u.test(char)
const isWordOperator = (word: string): boolean =>
  ['AND', 'OR', 'NOT', 'XOR', 'XNOR', 'NAND', 'NOR'].includes(word)

function readQuoted(source: string, start: number): { value: string; end: number; closed: boolean } {
  let index = start + 1
  let value = ''
  while (index < source.length) {
    const char = source[index]
    if (char === '"') return { value, end: index + 1, closed: true }
    if (char === '\\' && index + 1 < source.length) {
      const next = source[index + 1]
      // Backslashes only escape syntax characters; elsewhere they are data.
      if (ESCAPABLE_CHARACTERS.includes(next)) {
        value += next
        index += 2
        continue
      }
      value += char
      index++
      continue
    }
    value += char
    index++
  }
  return { value, end: source.length, closed: false }
}

function symbolAt(source: string, index: number): readonly [string, string] | undefined {
  return SYMBOL_OPERATORS.find(([symbol]) => source.startsWith(symbol, index))
}

/** `literal`, or a user alias that points at it (the alias map cannot reach `literal` through canonicalFieldName). */
function isLiteralFieldToken(token: string, aliases: QueryFieldAliases): boolean {
  if (token === 'literal') return true
  const target = aliases[token]
  return !FIELD_NAMES.has(token) && typeof target === 'string' && target.toLocaleLowerCase() === 'literal'
}

/** Whether `token` (lowercase, before the colon) names a built-in field, an alias or `literal`. */
const isFieldToken = (token: string, aliases: QueryFieldAliases): boolean =>
  isKnownFieldName(token, aliases) || isLiteralFieldToken(token, aliases)

/** Parse `1.5MB`, `500 KiB` or a plain byte count; undefined when the text is not a size. */
export function parseByteSize(value: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB)?\s*$/iu.exec(value)
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = (match[2] ?? 'B').toLocaleUpperCase()
  const power = unit.startsWith('G') ? 3 : unit.startsWith('M') ? 2 : unit.startsWith('K') ? 1 : 0
  return amount * Math.pow(1024, power)
}

export function parseDate(value: string): number | undefined {
  if (!value.trim()) return undefined
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : timestamp
}

const COUNT_FIELDS: ReadonlySet<string> = new Set(['words', 'wordcount', 'tagcount', 'linkcount', 'backlinkcount', 'taskcount'])

/** Why a numeric or date field can never match its value, or undefined when the value is usable. */
function numericValueProblem(field: string, value: string): string | undefined {
  const text = value.trim()
  if (!text) return undefined
  if (field === 'size' && parseByteSize(text) === undefined) {
    return `Invalid size "${text}". Use a number with an optional unit (B, KB, KiB, MB, MiB, GB, GiB), for example size:>1MB.`
  }
  if (COUNT_FIELDS.has(field) && Number.isNaN(Number(text))) {
    return `Invalid number "${text}" for ${field}:. Use a number, for example ${field}:>10.`
  }
  if ((field === 'created' || field === 'modified') && parseDate(text) === undefined) {
    return `Invalid date "${text}" for ${field}:. Use a date such as ${field}:>2026-01-31.`
  }
  return undefined
}

/** The hint for `word:` when `word` is no field: the text is searched as typed. */
function unknownFieldHint(word: string, aliases: QueryFieldAliases): string {
  const suggestion = closestFieldName(word, [...FIELD_NAMES, 'literal', ...Object.keys(aliases)])
  return suggestion
    ? `Unknown field "${word}:", did you mean "${suggestion}:"? Searching for the text literally.`
    : `Unknown field "${word}:". Searching for the text literally.`
}

function reportEmptyValue(label: string, span: SourceSpan, diagnostics: QueryDiagnostic[]): void {
  diagnostics.push({ message: `"${label}" has no value yet, so it matches nothing.`, start: span.start, end: span.end, severity: 'warning' })
}

/** Symbolic operators that also occur in everyday prose (`Q & A`, `2 ^ 3`, `Wow !`). */
const WEAK_SYMBOL_OPERATORS: ReadonlySet<string> = new Set(['&', '^', '!'])

/**
 * `word:` followed by more words, as in `Note: remember the milk` or `title: foo`. Nothing sits after
 * the colon, so it is not a field predicate; it is read as text (see Parser.hintDanglingField).
 */
function isDanglingFieldWord(tokens: readonly Lexeme[], index: number): boolean {
  const token = tokens[index]
  if (!token || token.kind !== 'atom' || !/^[a-z][a-z0-9-]*:$/iu.test(token.value ?? '')) return false
  const next = tokens[index + 1]
  return next?.kind === 'atom' || next?.kind === 'phrase'
}

/** Optimal string alignment distance: edits and swaps of neighbouring letters count as one. */
function editDistance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) rows[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1)
    }
  }
  return rows[a.length][b.length]
}

/** The field name a mistyped word most likely means, or undefined when nothing is close. */
function closestFieldName(word: string, candidates: readonly string[]): string | undefined {
  if (word.length < 3) return undefined
  const limit = word.length <= 4 ? 1 : 2
  let best: { name: string, distance: number } | undefined
  for (const name of candidates) {
    const distance = editDistance(word, name)
    if (distance <= limit && (!best || distance < best.distance)) best = { name, distance }
  }
  return best?.name
}

/**
 * Split the query into lexemes.
 *
 * Syntax characters are syntax only at the edge of a word. A parenthesis inside a word (`foo(bar`) and
 * a symbol such as `&` or `^` inside one (`R&D`) are text, a `)` that closes nothing is text, and a
 * symbolic operator is an operator only when it stands alone. With `freeText` set nothing is syntax
 * except a complete quoted phrase; that is how a query without fields, tags or Boolean operators is read.
 */
function lex(source: string, diagnostics: QueryDiagnostic[], freeText = false): Lexeme[] {
  const lexemes: Lexeme[] = []
  // Parentheses currently open: a group opened at the start of a word, or text opened inside a word.
  const open: Array<'group' | 'text'> = []
  const atBoundary = (position: number): boolean =>
    position >= source.length || isSpace(source[position]) || source[position] === '(' || source[position] === ')'
  let index = 0
  while (index < source.length) {
    if (isSpace(source[index])) {
      index++
      continue
    }
    if (!freeText && source[index] === '(') {
      open.push('group')
      lexemes.push({ kind: 'lparen', raw: '(', start: index, end: index + 1 })
      index++
      continue
    }
    if (!freeText && source[index] === ')') {
      const innermost = open[open.length - 1]
      if (innermost === 'group') {
        open.pop()
        lexemes.push({ kind: 'rparen', raw: ')', start: index, end: index + 1 })
        index++
        continue
      }
      // A stray `)`, or one that closes a text `(`, is text and starts a word below.
      if (innermost === 'text') open.pop()
    }
    if (source[index] === '"') {
      const quoted = readQuoted(source, index)
      // In free text an unterminated quote is an ordinary character, handled in the word loop.
      if (quoted.closed || !freeText) {
        lexemes.push({
          kind: 'phrase', raw: source.slice(index, quoted.end), value: quoted.value,
          start: index, end: quoted.end,
        })
        if (!quoted.closed) {
          diagnostics.push({
            message: 'Unterminated quoted phrase.', start: index, end: source.length, severity: 'error',
          })
        }
        index = quoted.end
        continue
      }
    }

    if (!freeText) {
      if (source[index] === '!') {
        // Compound operators need a boundary after them. A `!` right in front of a word negates it;
        // a lone `!` (as in French "Bonjour !") is text.
        const compound = symbolAt(source, index)
        if (compound && atBoundary(index + compound[0].length)) {
          lexemes.push({ kind: 'operator', raw: compound[0], operator: compound[1], start: index, end: index + compound[0].length })
          index += compound[0].length
          continue
        }
        if (index + 1 < source.length && !isSpace(source[index + 1])) {
          lexemes.push({ kind: 'operator', raw: '!', operator: 'NOT', start: index, end: index + 1 })
          index++
          continue
        }
      } else {
        const leadingSymbol = symbolAt(source, index)
        if (leadingSymbol && atBoundary(index + leadingSymbol[0].length)) {
          lexemes.push({ kind: 'operator', raw: leadingSymbol[0], operator: leadingSymbol[1], start: index, end: index + leadingSymbol[0].length })
          index += leadingSymbol[0].length
          continue
        }
        // A hyphen directly in front of a group negates it: `-(a OR b)` is `NOT (a OR b)`.
        if (source[index] === '-' && source[index + 1] === '(') {
          lexemes.push({ kind: 'operator', raw: '-', operator: 'NOT', start: index, end: index + 1 })
          index++
          continue
        }
      }
    }

    let value = ''
    let quoteWasClosed = true
    const start = index
    while (index < source.length && !isSpace(source[index])) {
      const char = source[index]
      if (!freeText && (char === '(' || char === ')')) {
        if (char === '(') {
          // A `(` right after a Boolean word (`NOT(...)`, `AND(...)`) opens a group; elsewhere it is text.
          if (value.length === 0 || isWordOperator(value)) break
          open.push('text')
        } else if (value.length > 0 && open[open.length - 1] === 'group') {
          break
        } else if (value.length > 0 && open[open.length - 1] === 'text') {
          open.pop()
        }
        value += char
        index++
        continue
      }
      // A backslash and the syntax character it escapes stay in the word together, so `\(`, `\)`,
      // `\"` and `\^` are data here; `decodeValue` removes the backslash later.
      if (char === '\\' && index + 1 < source.length && ESCAPABLE_CHARACTERS.includes(source[index + 1])) {
        value += char + source[index + 1]
        index += 2
        continue
      }
      if (char === '"') {
        const quoted = readQuoted(source, index)
        if (!quoted.closed && freeText) {
          value += char
          index++
          continue
        }
        value += source.slice(index, quoted.end)
        quoteWasClosed = quoted.closed
        index = quoted.end
        continue
      }
      value += char
      index++
    }
    if (!quoteWasClosed) {
      diagnostics.push({ message: 'Unterminated quoted value.', start, end: source.length, severity: 'error' })
    }
    if (!value.length) {
      // Defensive progress guarantee for odd punctuation sequences.
      value = source[index] ?? ''
      index++
    }
    const end = index
    const raw = source.slice(start, end)
    const decoded = value
    const op = isWordOperator(decoded) ? decoded : undefined
    lexemes.push(op
      ? { kind: 'operator', raw, operator: op, start, end }
      : { kind: 'atom', raw, value: decoded, start, end })
  }
  lexemes.push({ kind: 'eof', raw: '', start: source.length, end: source.length })
  return lexemes
}

function unquote(raw: string): string {
  if (raw.startsWith('"')) {
    const parsed = readQuoted(raw, 0)
    return parsed.value
  }
  return raw
}

/** True when a quoted value is followed by more text, which `unquote` would silently drop. */
function textAfterClosingQuote(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('"')) return false
  const quoted = readQuoted(trimmed, 0)
  return quoted.closed && quoted.end < trimmed.length
}

function reportTextAfterClosingQuote(raw: string, span: SourceSpan, diagnostics: QueryDiagnostic[]): void {
  if (textAfterClosingQuote(raw)) {
    diagnostics.push({ message: 'Unexpected text after closing quote.', start: span.start, end: span.end, severity: 'error' })
  }
}

function findOutsideQuotes(input: string, needle: string): number {
  let quoted = false
  let escaped = false
  for (let index = 0; index <= input.length - needle.length; index++) {
    const char = input[index]
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (!quoted && input.startsWith(needle, index)) return index
  }
  return -1
}

function decodeValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"')) return unquote(trimmed)
  return trimmed.replace(/\\(["\\*:=^~()])/gu, '$1')
}

function decodeTagPattern(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('"')) return trimmed
  const closingQuote = trimmed.endsWith('"') && trimmed.length > 1 ? trimmed.length - 1 : trimmed.length
  // In tag patterns, `\*` is meaningful to the glob compiler; only decode
  // escaped quotes and escaped backslashes at this stage.
  return trimmed.slice(1, closingQuote).replace(/\\(["\\])/gu, '$1')
}

function decodeScalar(raw: string): unknown {
  const text = decodeValue(raw)
  if (raw.trim().startsWith('"')) return text
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(text)) return Number(text)
  if (/^\d{4}-\d{2}-\d{2}(?:$|T)/u.test(text) && !Number.isNaN(Date.parse(text))) {
    return new Date(text).getTime()
  }
  return text
}

function parseProperty(raw: string, span: SourceSpan, diagnostics: QueryDiagnostic[]): PropertyNode | null {
  const expression = raw.trim()
  let quote = false
  let escaped = false
  let opAt = -1
  let comparison: ComparisonOperator | undefined
  const operators: ComparisonOperator[] = ['>=', '<=', '!=', '~=', '=', '>', '<']
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index]
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === '"') { quote = !quote; continue }
    if (quote) continue
    const operator = operators.find(candidate => expression.startsWith(candidate, index))
    if (operator) { opAt = index; comparison = operator; break }
  }
  const nameRaw = opAt === -1 ? expression : expression.slice(0, opAt)
  const name = decodeValue(nameRaw).trim()
  if (!name) return null
  reportTextAfterClosingQuote(nameRaw, span, diagnostics)
  if (opAt !== -1) reportTextAfterClosingQuote(expression.slice(opAt + comparison!.length), span, diagnostics)
  if (opAt === -1) {
    return { kind: 'property', name, comparison: 'exists', raw: `property:${raw}`, ...span }
  }
  const rawValue = expression.slice(opAt + comparison!.length)
  // A trailing comparison operator is a normal editing state (for example
  // `property:status=`). Keep it as an incomplete property node without a
  // parser error so the UI neither shouts nor falls back to a text query.
  if (!rawValue.trim()) {
    reportEmptyValue(`property:${name}${comparison}`, span, diagnostics)
    return { kind: 'property', name, comparison: comparison!, value: undefined, rawValue, raw: `property:${raw}`, ...span }
  }
  return {
    kind: 'property', name, comparison: comparison!, value: decodeScalar(rawValue),
    rawValue, raw: `property:${raw}`, ...span,
  }
}

function parseFieldAtom(lexeme: Lexeme, diagnostics: QueryDiagnostic[], aliases: QueryFieldAliases, exemptions: readonly RegExp[]): QueryNode | null {
  const value = lexeme.value ?? lexeme.raw
  const colon = findOutsideQuotes(value, ':')
  if (colon < 1) return null
  const fieldToken = value.slice(0, colon).toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/u.test(fieldToken)) return null
  const field = canonicalFieldName(fieldToken, aliases)
  const rawValue = value.slice(colon + 1)

  if (!FIELD_NAMES.has(field)) {
    // Words matching a literal prefix (by default URLs and Windows drive paths) are ordinary text.
    if (isLiteralPrefixed(value, exemptions)) return null
    // An unknown field is not an error: the word is searched as plain text, and the hint says so.
    diagnostics.push({ message: unknownFieldHint(field, aliases), start: lexeme.start, end: lexeme.end, severity: 'warning' })
    return { kind: 'text', value, raw: lexeme.raw, start: lexeme.start, end: lexeme.end }
  }
  if (field === 'property') {
    // `property:` by itself is an ordinary editing state. It selects no files,
    // stays on the structured-query path, and does not emit a transient error.
    if (!rawValue.trim()) {
      reportEmptyValue(`${fieldToken}:`, lexeme, diagnostics)
      return { kind: 'property', name: '', comparison: 'exists', raw: `property:${rawValue}`, start: lexeme.start, end: lexeme.end }
    }
    const property = parseProperty(rawValue, { start: lexeme.start, end: lexeme.end }, diagnostics)
    if (!property) {
      diagnostics.push({ message: 'Invalid property expression; expected property:name or property:name=value.', start: lexeme.start, end: lexeme.end, severity: 'error' })
      return { kind: 'text', value, raw: lexeme.raw, start: lexeme.start, end: lexeme.end }
    }
    return property
  }

  if (field === 'tag') {
    // `tag:=...` selects exact complete tag-path matching. The optional `#`
    // after the modifier is syntax only; it is not part of the stored pattern.
    const tagExact = rawValue.startsWith('=')
    const patternRaw = tagExact ? rawValue.slice(1) : rawValue
    reportTextAfterClosingQuote(patternRaw, lexeme, diagnostics)
    // Preserve `\*` inside quoted patterns so the glob compiler can distinguish
    // a literal asterisk from an active wildcard.
    const pattern = decodeTagPattern(patternRaw).replace(/^#/u, '')
    // While the user has typed only `tag:` (or `tag:#`), show the same live
    // set as `has:tag` instead of surfacing an error for an unfinished value.
    if (!pattern && !tagExact) {
      return { kind: 'field', field: 'has', value: 'tag', raw: lexeme.raw, start: lexeme.start, end: lexeme.end }
    }
    if (/^[\^~]/u.test(pattern)) {
      diagnostics.push({
        message: `Tags have no "${pattern[0]}" form: tag:${pattern.slice(1)} already matches from the start, and tag:=${pattern.slice(1)} matches exactly.`,
        start: lexeme.start, end: lexeme.end, severity: 'error',
      })
    }
    // `tag:=` has no path yet; malformed non-empty paths are diagnosed by the validator below.
    if (!pattern) reportEmptyValue(`${fieldToken}:=`, lexeme, diagnostics)
    return { kind: 'field', field: 'tag', value: pattern, tagExact, raw: lexeme.raw, start: lexeme.start, end: lexeme.end }
  }

  if (field === 'literal') {
    // An empty literal is an in-progress input, not an error worth surfacing.
    return { kind: 'literal', value: decodeValue(rawValue), raw: lexeme.raw, start: lexeme.start, end: lexeme.end }
  }

  // Keep every known structured field quiet while the user has only typed the
  // field name and colon. The evaluator returns no matches for this state; it
  // must not fall back to ordinary full-text search or retain stale results.
  if (!rawValue.trim()) {
    reportEmptyValue(`${fieldToken}:`, lexeme, diagnostics)
    return { kind: 'field', field, value: '', raw: lexeme.raw, start: lexeme.start, end: lexeme.end }
  }

  let fieldValue = decodeValue(rawValue)
  let titleMode: TitleMatchMode | undefined
  let matchMode: TextMatchMode = 'substring'
  let globPattern: string | undefined
  const trimmedRawValue = rawValue.trimStart()
  const quotedValue = trimmedRawValue.startsWith('"')
  // The value after an optional `=`, `^` or `~` modifier.
  let body = trimmedRawValue
  if (!quotedValue) {
    if (trimmedRawValue.startsWith('=')) { matchMode = 'exact'; body = trimmedRawValue.slice(1) }
    else if (trimmedRawValue.startsWith('^')) { matchMode = 'prefix'; body = trimmedRawValue.slice(1) }
    else if (trimmedRawValue.startsWith('~')) { matchMode = 'substring'; body = trimmedRawValue.slice(1) }
    const hasModifier = body !== trimmedRawValue
    if (hasModifier) fieldValue = decodeValue(body)
    // Wildcards work in every unquoted form; a modifier only decides where the pattern is anchored.
    if (!body.trimStart().startsWith('"') && hasUnescapedWildcard(body)) {
      globPattern = body.trim()
      if (!hasModifier) matchMode = 'glob'
    }
    if (field === 'title') titleMode = matchMode === 'glob' ? 'substring' : matchMode
  }
  reportTextAfterClosingQuote(body, lexeme, diagnostics)

  let comparison: ComparisonOperator | undefined
  if (['size', 'words', 'wordcount', 'tagcount', 'linkcount', 'backlinkcount', 'taskcount', 'created', 'modified'].includes(field)) {
    const operatorMatch = /^(>=|<=|!=|~=|>|<|=)(.*)$/su.exec(fieldValue)
    if (operatorMatch) {
      comparison = operatorMatch[1] as ComparisonOperator
      fieldValue = operatorMatch[2]
      // `size:>=` / `created:>` are unfinished comparisons, so keep them
      // non-matching and quiet until the user supplies a value.
    }
  }
  if (!fieldValue.trim()) reportEmptyValue(`${fieldToken}:`, lexeme, diagnostics)
  return {
    kind: 'field', field, value: fieldValue, comparison, titleMode, matchMode, rawValue, globPattern,
    raw: lexeme.raw, start: lexeme.start, end: lexeme.end,
  }
}

class Parser {
  private position = 0
  constructor(
    private readonly lexemes: Lexeme[],
    private readonly diagnostics: QueryDiagnostic[],
    private readonly aliases: QueryFieldAliases = {},
    private readonly exemptions: readonly RegExp[] = [],
  ) {}

  parse(): QueryNode | null {
    if (this.current().kind === 'eof') return null
    const node = this.parseOr()
    while (this.current().kind !== 'eof') {
      const current = this.current()
      if (current.kind === 'rparen') {
        this.diagnostics.push({ message: 'Unmatched closing parenthesis.', start: current.start, end: current.end, severity: 'error' })
        this.advance()
      } else {
        this.diagnostics.push({ message: `Unexpected token "${current.raw}".`, start: current.start, end: current.end, severity: 'error' })
        this.advance()
      }
    }
    return node
  }

  private parseOr(): QueryNode {
    let left = this.parseXor()
    while (this.current().kind === 'operator' && ['OR', 'NOR'].includes(this.current().operator ?? '')) {
      const op = this.advance()
      const right = this.parseXorOrDiagnose(op)
      left = this.binary(op, left, right)
    }
    return left
  }

  private parseXor(): QueryNode {
    let left = this.parseAnd()
    while (this.current().kind === 'operator' && ['XOR', 'XNOR'].includes(this.current().operator ?? '')) {
      const op = this.advance()
      const right = this.parseAndOrDiagnose(op)
      left = this.binary(op, left, right)
    }
    return left
  }

  private parseAnd(): QueryNode {
    let left = this.parseUnary()
    while (true) {
      const current = this.current()
      if (current.kind === 'operator' && ['AND', 'NAND'].includes(current.operator ?? '')) {
        const op = this.advance()
        const right = this.parseUnaryOrDiagnose(op)
        left = this.binary(op, left, right)
        continue
      }
      if (this.canStartPrimary(current)) {
        const right = this.parseImplicitRight()
        if (this.isFreeTextNode(left) && this.isFreeTextNode(right)) {
          // Adjacent ordinary words/phrases form one Banana text query;
          // do not silently change its OR/tokenization/ranking behavior into
          // a mandatory per-token conjunction inside mixed Boolean syntax.
          left = this.mergeFreeText(left, right)
        } else {
          // Adjacent independent predicates imply AND.
          left = {
            kind: 'binary', operator: 'AND', left, right,
            raw: `${left.raw} ${right.raw}`, start: left.start, end: right.end,
          }
        }
        continue
      }
      break
    }
    return left
  }

  private parseUnary(): QueryNode {
    const current = this.current()
    if (current.kind === 'operator' && current.operator === 'NOT') {
      const op = this.advance()
      if (!this.canStartPrimary(this.current())) {
        this.diagnostics.push({ message: 'NOT requires an expression.', start: op.start, end: op.end, severity: 'error' })
        return { kind: 'not', child: { kind: 'text', value: '', raw: '', start: op.end, end: op.end }, raw: op.raw, start: op.start, end: op.end }
      }
      const child = this.parseImplicitRight()
      return { kind: 'not', child, raw: `${op.raw} ${child.raw}`, start: op.start, end: child.end }
    }
    const node = this.parsePrimary()
    // Banana's legacy -term exclusion is preserved as unary negation when
    // it appears as a standalone query atom; embedded hyphens are untouched.
    if (node.kind === 'text' && node.value.startsWith('-') && node.value.length > 1) {
      const value = node.value.slice(1)
      return {
        kind: 'not', child: { ...node, value, raw: value },
        raw: node.raw, start: node.start, end: node.end,
      }
    }
    return node
  }

  private parsePrimary(): QueryNode {
    const current = this.current()
    if (current.kind === 'lparen') {
      const open = this.advance()
      if (this.current().kind === 'rparen') {
        const close = this.advance()
        this.diagnostics.push({ message: 'Empty parentheses are not a query expression.', start: open.start, end: close.end, severity: 'error' })
        return { kind: 'text', value: '', raw: '()', start: open.start, end: close.end }
      }
      const child = this.parseOr()
      if (this.current().kind === 'rparen') {
        const close = this.advance()
        // A grouped predicate keeps the spelling it was typed with: predicate `raw` is searched for
        // literally and masked out of note text, so it must not gain the parentheses and padding spaces.
        const isPredicate = isQueryNodeLeaf(child) && !this.isFreeTextNode(child)
        const raw = isPredicate ? child.raw : this.lexemes.slice(this.positionAt(open), this.position).map(t => t.raw).join(' ')
        return { ...child, raw, start: open.start, end: close.end }
      }
      this.diagnostics.push({ message: 'Unmatched opening parenthesis.', start: open.start, end: open.end, severity: 'error' })
      return child
    }
    if (current.kind === 'operator') {
      const wordOperator = current.raw === current.operator && current.operator !== 'NOT'
      const bad = this.advance()
      if (wordOperator) return { kind: 'text', value: bad.raw, raw: bad.raw, start: bad.start, end: bad.end }
      this.diagnostics.push({ message: `Unexpected operator "${bad.raw}".`, start: bad.start, end: bad.end, severity: 'error' })
      return { kind: 'text', value: '', raw: bad.raw, start: bad.start, end: bad.end }
    }
    if (current.kind === 'rparen' || current.kind === 'eof') {
      this.diagnostics.push({ message: 'Expected a query expression.', start: current.start, end: current.end, severity: 'error' })
      return { kind: 'text', value: '', raw: '', start: current.start, end: current.end }
    }
    this.advance()
    if (current.kind === 'phrase' && !(current.value ?? '').trim()) {
      this.diagnostics.push({ message: 'Empty quotes match nothing.', start: current.start, end: current.end, severity: 'warning' })
    }
    if (current.kind === 'phrase') {
      return { kind: 'phrase', value: current.value ?? '', raw: current.raw, start: current.start, end: current.end }
    }
    const rawValue = current.value ?? current.raw
    if (rawValue.startsWith('-"') && rawValue.endsWith('"')) {
      const quoted = readQuoted(rawValue, 1)
      if (!quoted.value.trim()) this.diagnostics.push({ message: 'Empty quotes match nothing.', start: current.start, end: current.end, severity: 'warning' })
      const child: PhraseNode = { kind: 'phrase', value: quoted.value, raw: rawValue.slice(1), start: current.start + 1, end: current.end }
      return { kind: 'not', child, raw: current.raw, start: current.start, end: current.end }
    }
    // `word: more words` has no value after the colon. It is plain text, with a hint when `word` is, or
    // nearly is, a field name.
    if (isDanglingFieldWord(this.lexemes, this.lexemes.indexOf(current))) {
      this.hintDanglingField(current)
      return { kind: 'text', value: decodeValue(rawValue), raw: current.raw, start: current.start, end: current.end }
    }
    // A leading hyphen negates exactly like NOT: `-tag:#archived`, `-#archived` and `-literal:x` mean
    // NOT of the predicate, and `-foo:bar` reports the same unsupported field as `NOT foo:bar`. Any other
    // word that starts with a hyphen is a legacy term exclusion, handled in parseUnary.
    if (rawValue.startsWith('-') && rawValue.length > 1) {
      const positive: Lexeme = { ...current, raw: rawValue.slice(1), value: rawValue.slice(1), start: current.start + 1 }
      const child = this.parsePredicate(positive)
      if (child) return { kind: 'not', child, raw: `-${child.raw}`, start: current.start, end: child.end }
    }
    const predicate = this.parsePredicate(current)
    if (predicate) return predicate
    if (/^[^\p{L}\p{N}]+$/u.test(rawValue) && rawValue.length > 0) {
      // Bare punctuation is still a semantic/rendered-text search. Only the
      // explicit literal: form opts into raw-source character matching.
      return { kind: 'text', value: decodeValue(rawValue), raw: current.raw, start: current.start, end: current.end }
    }
    return { kind: 'text', value: decodeValue(rawValue), raw: current.raw, start: current.start, end: current.end }
  }

  /** Parse one atom as a structured predicate (`literal:`, `field:value`, `#tag`); null means plain text. */
  private parsePredicate(lexeme: Lexeme): QueryNode | null {
    const rawValue = lexeme.value ?? lexeme.raw
    const colon = findOutsideQuotes(rawValue, ':')
    if (colon > 0) {
      if (this.isLiteralField(rawValue.slice(0, colon).toLowerCase())) {
        const literal = rawValue.slice(colon + 1)
        reportTextAfterClosingQuote(literal, lexeme, this.diagnostics)
        if (/^[=^~]/u.test(literal)) {
          this.diagnostics.push({
            message: `"literal:" searches the text as typed, so the "${literal[0]}" is part of it. Write literal:"…" to search the words alone.`,
            start: lexeme.start, end: lexeme.end, severity: 'warning',
          })
        }
        if (!decodeValue(literal).trim()) reportEmptyValue(`${rawValue.slice(0, colon).toLowerCase()}:`, lexeme, this.diagnostics)
        return { kind: 'literal', value: decodeValue(literal), raw: lexeme.raw, start: lexeme.start, end: lexeme.end }
      }
      const fieldNode = parseFieldAtom(this.extendOpenValue(lexeme), this.diagnostics, this.aliases, this.exemptions)
      if (fieldNode) return fieldNode
    }
    if (rawValue.startsWith('#') && rawValue.length > 1) {
      return { kind: 'tag', pattern: rawValue.slice(1), bare: true, literalNeedle: rawValue, raw: lexeme.raw, start: lexeme.start, end: lexeme.end }
    }
    return null
  }

  private isLiteralField(token: string): boolean {
    return isLiteralFieldToken(token, this.aliases)
  }

  /**
   * An unquoted `=` or `^` value of a text field may span spaces: `title:=AI Roadmap` means
   * `title:="AI Roadmap"`, wherever the predicate appears. The plain words that follow are read into the
   * same atom, stopping at an operator, parenthesis, quoted phrase, `#tag`, `-term` or `field:value`.
   * Doing this here, before the value is wrapped in a group or a NOT, keeps a quoted value or one ended
   * by a closing parenthesis complete.
   */
  private extendOpenValue(lexeme: Lexeme): Lexeme {
    const value = lexeme.value ?? lexeme.raw
    const colon = findOutsideQuotes(value, ':')
    if (colon < 1) return lexeme
    const field = canonicalFieldName(value.slice(0, colon).toLowerCase(), this.aliases)
    if (!MULTIWORD_FIELDS.has(field)) return lexeme
    const rawValue = value.slice(colon + 1)
    if (!/^[=^]/u.test(rawValue) || /^[=^]"/u.test(rawValue)) return lexeme
    let extended = lexeme
    for (let next = this.current(); next.kind === 'atom'; next = this.current()) {
      const word = next.value ?? next.raw
      if (findOutsideQuotes(word, ':') >= 0 || word.startsWith('#') || word.startsWith('-')) break
      this.advance()
      extended = { ...extended, raw: `${extended.raw} ${next.raw}`, value: `${extended.value ?? extended.raw} ${word}`, end: next.end }
    }
    return extended
  }

  /** Tell the user that `word:` followed by text is searched literally, when `word` is or nearly is a field. */
  private hintDanglingField(lexeme: Lexeme): void {
    const word = (lexeme.value ?? lexeme.raw).slice(0, -1).toLowerCase()
    const isField = isFieldToken(word, this.aliases)
    // Ordinary prose such as `Note: remember the milk` stays silent; only a probable mistyped field speaks up.
    if (!isField && !closestFieldName(word, [...FIELD_NAMES, 'literal', ...Object.keys(this.aliases)])) return
    this.diagnostics.push({
      message: isField
        ? `"${word}:" needs a value right after the colon. Searching for the text literally.`
        : unknownFieldHint(word, this.aliases),
      start: lexeme.start, end: lexeme.end, severity: 'warning',
    })
  }

  private canStartPrimary(lexeme: Lexeme): boolean {
    if (lexeme.kind === 'atom' || lexeme.kind === 'phrase' || lexeme.kind === 'lparen') return true
    return lexeme.kind === 'operator' && lexeme.operator === 'NOT'
  }

  private parseAndOrDiagnose(operator: Lexeme): QueryNode {
    if (!this.canStartPrimary(this.current())) {
      this.diagnostics.push({ message: `Operator ${operator.raw} requires a right operand.`, start: operator.start, end: operator.end, severity: 'error' })
      return { kind: 'text', value: '', raw: '', start: operator.end, end: operator.end }
    }
    return this.parseAnd()
  }

  private parseXorOrDiagnose(operator: Lexeme): QueryNode {
    if (!this.canStartPrimary(this.current())) {
      this.diagnostics.push({ message: `Operator ${operator.raw} requires a right operand.`, start: operator.start, end: operator.end, severity: 'error' })
      return { kind: 'text', value: '', raw: '', start: operator.end, end: operator.end }
    }
    return this.parseXor()
  }

  private parseUnaryOrDiagnose(operator: Lexeme): QueryNode {
    if (!this.canStartPrimary(this.current())) {
      this.diagnostics.push({ message: `Operator ${operator.raw} requires a right operand.`, start: operator.start, end: operator.end, severity: 'error' })
      return { kind: 'text', value: '', raw: '', start: operator.end, end: operator.end }
    }
    return this.parseImplicitRight()
  }

  private parseImplicitRight(): QueryNode {
    if (!this.isFreeTextLexeme(this.current())) return this.parseUnary()
    let node = this.parseUnary()
    while (this.isFreeTextLexeme(this.current())) {
      const next = this.parseUnary()
      if (!this.isFreeTextNode(node) || !this.isFreeTextNode(next)) break
      node = this.mergeFreeText(node, next)
    }
    return node
  }

  private isFreeTextLexeme(lexeme: Lexeme): boolean {
    if (lexeme.kind === 'phrase') return true
    if (lexeme.kind !== 'atom') return false
    const value = lexeme.value ?? lexeme.raw
    if (!value || value.startsWith('#') || value.startsWith('-')) return false
    if (!/[\p{L}\p{N}]/u.test(value)) return false
    if (isDanglingFieldWord(this.lexemes, this.lexemes.indexOf(lexeme))) return true
    const colon = findOutsideQuotes(value, ':')
    if (colon > 0 && /^[a-z][a-z0-9-]*$/iu.test(value.slice(0, colon))) {
      // A word before the colon that is no field makes the whole word plain text.
      return !isFieldToken(value.slice(0, colon).toLowerCase(), this.aliases)
    }
    return true
  }

  private isFreeTextNode(node: QueryNode): node is TextNode | PhraseNode | TextQueryNode {
    return node.kind === 'text' || node.kind === 'phrase' || node.kind === 'textQuery'
  }

  private mergeFreeText(left: TextNode | PhraseNode | TextQueryNode, right: TextNode | PhraseNode | TextQueryNode): TextQueryNode {
    const phrases = [
      ...(left.kind === 'phrase' ? [left.value] : left.kind === 'textQuery' ? left.phraseValues : []),
      ...(right.kind === 'phrase' ? [right.value] : right.kind === 'textQuery' ? right.phraseValues : []),
    ]
    const query = `${left.raw} ${right.raw}`.trim()
    return { kind: 'textQuery', query, phraseValues: phrases, raw: query, start: left.start, end: right.end }
  }

  private binary(operator: Lexeme, left: QueryNode, right: QueryNode): BinaryNode {
    return {
      kind: 'binary', operator: operator.operator as BooleanOperator, left, right,
      raw: `${left.raw} ${operator.raw} ${right.raw}`, start: left.start, end: right.end,
    }
  }

  private current(): Lexeme { return this.lexemes[this.position] ?? this.lexemes[this.lexemes.length - 1] }
  private advance(): Lexeme { const token = this.current(); if (token.kind !== 'eof') this.position++; return token }
  private get positionAt(): (lexeme: Lexeme) => number {
    return (lexeme: Lexeme) => this.lexemes.indexOf(lexeme)
  }
}

/** Parse a complete query and return syntax errors without throwing. */
export function parseQueryLanguage(
  source: string,
  options: QueryLanguageOptions = {},
): ParsedQueryLanguage {
  const diagnostics: QueryDiagnostic[] = []
  const exemptions = compileLiteralPrefixes(Array.isArray(options.literalPrefixes) ? options.literalPrefixes : DEFAULT_LITERAL_PREFIXES)
  // Which kinds of query syntax a token list contains. Parentheses, `&`, `^` and `!` do not count on
  // their own, and neither does a `word:` followed by more words, because all of them occur in prose.
  const syntaxOf = (tokens: readonly Lexeme[]) => ({
    hasStructuredField: tokens.some((token, tokenIndex) => {
      if (token.kind !== 'atom' || isDanglingFieldWord(tokens, tokenIndex)) return false
      const value = token.value ?? token.raw
      const fieldProbe = value.startsWith('-') ? value.slice(1) : value
      const colon = findOutsideQuotes(fieldProbe, ':')
      if (colon <= 0 || !/^[a-z][a-z0-9-]*$/iu.test(fieldProbe.slice(0, colon))) return false
      // Only a real field makes a query structured; `foo:bar` is plain text.
      return isFieldToken(fieldProbe.slice(0, colon).toLowerCase(), options.fieldAliases ?? {})
    }),
    hasBoolOperator: tokens.some(token => token.kind === 'operator' && !WEAK_SYMBOL_OPERATORS.has(token.raw)),
    hasBareTag: tokens.some(token => {
      if (token.kind !== 'atom') return false
      const value = token.value ?? ''
      return (value.startsWith('-') ? value.slice(1) : value).startsWith('#')
    }),
  })
  let lexemes = lex(source, diagnostics)
  // A query with no fields, tags or Boolean operators is free text, whatever punctuation it contains:
  // `foo(bar`, `Q & A`, `"for test` and `Bonjour !` are searched as typed and never raise syntax errors.
  const initialSyntax = syntaxOf(lexemes)
  if (!initialSyntax.hasStructuredField && !initialSyntax.hasBoolOperator && !initialSyntax.hasBareTag) {
    diagnostics.length = 0
    lexemes = lex(source, diagnostics, true)
  }
  let root: QueryNode | null = null
  let nesting = 0
  let excessiveNesting = false
  for (const lexeme of lexemes) {
    if (lexeme.kind === 'lparen') nesting++
    if (lexeme.kind === 'rparen') nesting = Math.max(0, nesting - 1)
    if (nesting > 64) excessiveNesting = true
  }
  try {
    if (lexemes.length > 513) {
      diagnostics.push({ message: 'Query is too complex (maximum 512 tokens).', start: 0, end: source.length, severity: 'error' })
    } else if (excessiveNesting) {
      diagnostics.push({ message: 'Query nesting exceeds the limit of 64 levels.', start: 0, end: source.length, severity: 'error' })
    } else {
      root = new Parser(lexemes, diagnostics, options.fieldAliases ?? {}, exemptions).parse()
    }
  } catch (error: unknown) {
    diagnostics.push({
      message: `Could not parse query: ${error instanceof Error ? error.message : 'unexpected parser error'}`,
      start: 0, end: source.length, severity: 'error',
    })
  }
  const validateNode = (node: QueryNode | null): void => {
    if (!node) return
    if (node.kind === 'tag') {
      if (node.pattern && !compileTagPattern(node.pattern)) diagnostics.push({ message: `Invalid tag pattern "${node.pattern}"; tag segments cannot be empty.`, start: node.start, end: node.end, severity: 'error' })
    } else if (node.kind === 'field') {
      if (node.field === 'tag' && node.value && !compileTagPattern(node.value, { exact: node.tagExact })) diagnostics.push({ message: `Invalid tag pattern "${node.value}"; tag segments cannot be empty.`, start: node.start, end: node.end, severity: 'error' })
      const knownEnumValues = (node: FieldNode, supportedValues: readonly string[]): boolean => {
        const rawValue = node.raw.slice(node.raw.indexOf(':') + 1).trimStart()
        const mode = rawValue.startsWith('=') ? 'exact'
          : rawValue.startsWith('^') ? 'prefix'
          : rawValue.startsWith('~') ? 'substring'
          : hasUnescapedWildcard(rawValue) ? 'glob' : 'progressive'
        const valueParts = normalizeQueryValue(node.value).split(/\s+/u).filter(Boolean)
        const rawPattern = rawValue.replace(/^[=^~]/u, '')
        const rawParts = rawPattern.split(/\s+/u).filter(Boolean)
        // An unquoted wildcard is a glob in every form; the modifier decides where it is anchored.
        const wildcard = !rawPattern.trimStart().startsWith('"') && hasUnescapedWildcard(rawPattern)
        const anchor = mode === 'prefix' ? 'start' : mode === 'substring' ? 'none' : 'full'
        if (!valueParts.length) return false
        return valueParts.every((part, index) => supportedValues.some(supported => {
          const candidate = normalizeQueryValue(supported)
          if (wildcard) return globPatternMatches(candidate, rawParts[index] ?? part, normalizeQueryValue, anchor)
          if (mode === 'exact') return candidate === part
          if (mode === 'prefix' || mode === 'progressive') return candidate.startsWith(part)
          if (mode === 'substring') return candidate.includes(part)
          // Use the corresponding raw token, so `\*` stays literal even if
          // a neighbouring token contains an active wildcard.
          return globPatternMatches(candidate, rawParts[index] ?? part, normalizeQueryValue)
        }))
      }
      const numericProblem = numericValueProblem(node.field, node.value)
      if (numericProblem) diagnostics.push({ message: numericProblem, start: node.start, end: node.end, severity: 'error' })
      if (node.field === 'format' && node.value.trim() && !knownEnumValues(node, ['markdown', 'pdf', 'office', 'image', 'canvas', 'text', 'other'])) diagnostics.push({ message: `Unsupported format "${node.value}". Supported values: markdown, pdf, office, image, canvas, text, other.`, start: node.start, end: node.end, severity: 'error' })
      if (node.field === 'type' && node.value.trim() && !knownEnumValues(node, ['note', 'document', 'image', 'canvas', 'other'])) diagnostics.push({ message: `Unsupported type "${node.value}". Supported values: note, document, image, canvas, other.`, start: node.start, end: node.end, severity: 'error' })
      if (node.field === 'has' && node.value.trim() && !knownEnumValues(node, ['tags', 'tag', 'aliases', 'alias', 'frontmatter', 'properties', 'headings', 'heading', 'tasks', 'task', 'links', 'link', 'embeds', 'embed', 'content'])) diagnostics.push({ message: `Unsupported has: predicate "${node.value}".`, start: node.start, end: node.end, severity: 'error' })
      if (node.field === 'is' && node.value.trim() && !knownEnumValues(node, ['empty', 'orphan', 'tagged', 'untagged', 'todo', 'done', 'note', 'attachment', 'linked', 'unlinked'])) diagnostics.push({ message: `Unsupported is: predicate "${node.value}".`, start: node.start, end: node.end, severity: 'error' })
      if (['empty', 'orphan'].includes(node.field) && node.value.trim() && !knownEnumValues(node, ['true', 'false'])) diagnostics.push({ message: `${node.field}: accepts true or false (prefixes are allowed while typing).`, start: node.start, end: node.end, severity: 'error' })
      if (['task-todo', 'task-done'].includes(node.field) && node.value.trim()) {
        const rawValue = node.raw.slice(node.raw.indexOf(':') + 1).trimStart()
        const mode: TextMatchMode = rawValue.startsWith('=') ? 'exact'
          : rawValue.startsWith('^') ? 'prefix'
          : rawValue.startsWith('~') ? 'substring'
          : hasUnescapedWildcard(rawValue) ? 'glob' : 'prefix'
        const typed = normalizeQueryValue(node.value)
        const rawPattern = rawValue.replace(/^[=^~]/u, '')
        const wildcard = !rawPattern.trimStart().startsWith('"') && hasUnescapedWildcard(rawPattern)
        const anchor = mode === 'prefix' ? 'start' : mode === 'substring' ? 'none' : 'full'
        const supported = ['true', 'false'].some(candidate => {
          if (wildcard) return globPatternMatches(candidate, rawPattern.trim(), normalizeQueryValue, anchor)
          if (mode === 'exact') return candidate === typed
          if (mode === 'prefix') return candidate.startsWith(typed)
          if (mode === 'substring') return candidate.includes(typed)
          return globPatternMatches(candidate, typed, normalizeQueryValue)
        })
        if (!supported) diagnostics.push({ message: `${node.field}: accepts true or false (prefixes are allowed while typing).`, start: node.start, end: node.end, severity: 'error' })
      }
    } else if (node.kind === 'binary') {
      validateNode(node.left); validateNode(node.right)
    } else if (node.kind === 'not') validateNode(node.child)
  }
  validateNode(root)
  const hasPunctuationOnly = lexemes.some(token => (token.kind === 'atom' || token.kind === 'phrase') && !!token.value && !/[\p{L}\p{N}]/u.test(token.kind === 'phrase' ? token.value : token.value))

  const { hasStructuredField, hasBareTag } = syntaxOf(lexemes)
  const hasBoolOperator = lexemes.some(token => token.kind === 'operator')
  const hasGrouping = lexemes.some(token => token.kind === 'lparen' || token.kind === 'rparen')
  const hasPunctuationOnlyText = root?.kind === 'literal' || hasPunctuationOnly
  const hasErrors = diagnostics.some(diagnostic => diagnostic.severity === 'error')
  const isAdvanced = hasStructuredField || hasBoolOperator || hasBareTag || hasGrouping || hasErrors || hasPunctuationOnlyText
  return { source, root, diagnostics, isAdvanced }
}

export function applyBooleanOperator(operator: BooleanOperator, left: boolean, right: boolean): boolean {
  switch (operator) {
    case 'AND': return left && right
    case 'OR': return left || right
    case 'XOR': return left !== right
    case 'NAND': return !(left && right)
    case 'NOR': return !(left || right)
    case 'XNOR': return left === right
  }
}

export interface MatchProvenance {
  semantic: boolean
  literal: boolean
}

export interface ProvenanceEvaluation {
  matched: boolean
  provenance: MatchProvenance
}

/** Truth-table and provenance rules used when composing matched AST leaves. */
export function combineMatchProvenance(
  operator: BooleanOperator,
  left: MatchProvenance | null,
  right: MatchProvenance | null
): ProvenanceEvaluation {
  const leftMatches = left !== null
  const rightMatches = right !== null
  const matched = applyBooleanOperator(operator, leftMatches, rightMatches)
  if (!matched) return { matched: false, provenance: { semantic: false, literal: false } }
  if (operator === 'NAND' || operator === 'NOR') {
    return { matched: true, provenance: { semantic: true, literal: false } }
  }
  if (operator === 'XNOR' && !leftMatches && !rightMatches) {
    return { matched: true, provenance: { semantic: true, literal: false } }
  }
  if (operator === 'XOR') {
    const winner = leftMatches ? left : right
    return { matched: true, provenance: { semantic: winner?.semantic ?? false, literal: winner?.literal ?? false } }
  }
  if (operator === 'AND') {
    return { matched: true, provenance: { semantic: !!left?.semantic || !!right?.semantic, literal: !!left?.literal || !!right?.literal } }
  }
  return { matched: true, provenance: { semantic: !!left?.semantic || !!right?.semantic, literal: !!left?.literal || !!right?.literal } }
}

export interface CompiledTagPattern {
  readonly original: string
  readonly exact: boolean
  readonly singleSegmentPrefix: boolean
  readonly segments: ReadonlyArray<{ globstar: boolean; matcher?: RegExp; prefixMatcher?: RegExp }>
}

const tagPatternCache = new Map<string, CompiledTagPattern | null>()
const MAX_TAG_PATTERN_CACHE = 256

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Compile a tag path matcher. Wildcards never cross `/`: `*` and `?` stay in
 * one segment, while `**` is special only as an entire segment. In progressive
 * mode, literal segments are prefixes; an unqualified one-segment pattern also
 * includes descendant tags. `exact` anchors the complete tag path.
 */
export function compileTagPattern(pattern: string, options: { exact?: boolean } = {}): CompiledTagPattern | null {
  const normalized = pattern.replace(/^#/u, '')
  const exact = options.exact ?? false
  const cacheKey = `${exact ? 'exact' : 'progressive'}:${normalized}`
  if (tagPatternCache.has(cacheKey)) return tagPatternCache.get(cacheKey) ?? null
  const parts = normalized.split('/')
  if (!normalized.length || parts.length > 64 || parts.some(part => !part.length)) {
    tagPatternCache.set(cacheKey, null)
    return null
  }
  const segments: Array<{ globstar: boolean; matcher?: RegExp; prefixMatcher?: RegExp }> = []
  for (const [partIndex, part] of parts.entries()) {
    if (part === '**') {
      if (!segments[segments.length - 1]?.globstar) segments.push({ globstar: true })
      continue
    }
    let source = ''
    let hasWildcard = false
    for (let index = 0; index < part.length; index++) {
      const char = part[index]
      if (char === '\\' && index + 1 < part.length && ['*', '?', '\\'].includes(part[index + 1])) {
        source += escapeRegex(part[index + 1])
        index++
      } else if (char === '*') {
        hasWildcard = true
        while (part[index + 1] === '*') index++
        source += '[^/]*'
      } else if (char === '?') {
        hasWildcard = true
        source += '[^/]'
      } else {
        source += escapeRegex(char)
      }
    }
    // A literal root followed by an explicit descendant wildcard names a
    // complete hierarchy root (`B/**`), not every root whose name starts B
    // (`BB`). Progressive prefixes still apply to later segments, including
    // `*/B/**`, where the agreed segment-prefix semantics allow `C/BB`.
    const explicitRootDescendants = partIndex === 0 && parts.slice(1).includes('**') && !hasWildcard
    segments.push({
      globstar: false,
      matcher: new RegExp(`^${source}$`, 'iu'),
      prefixMatcher: !exact && !hasWildcard && !explicitRootDescendants ? new RegExp(`^${source}`, 'iu') : undefined,
    })
  }
  const compiled: CompiledTagPattern = {
    original: pattern,
    exact,
    singleSegmentPrefix: !exact && !normalized.includes('/') && !parts.includes('**'),
    segments,
  }
  if (tagPatternCache.size >= MAX_TAG_PATTERN_CACHE) tagPatternCache.clear()
  tagPatternCache.set(cacheKey, compiled)
  return compiled
}

export function matchTagPattern(compiled: CompiledTagPattern, tagPath: string): boolean {
  const tagSegments = tagPath.replace(/^#/u, '').split('/')
  const visit = (patternIndex: number, tagIndex: number): boolean => {
    if (patternIndex === compiled.segments.length) {
      if (compiled.exact) return tagIndex === tagSegments.length
      if (compiled.singleSegmentPrefix) return tagIndex <= tagSegments.length
      return tagIndex === tagSegments.length
    }
    const segment = compiled.segments[patternIndex]
    if (segment.globstar) {
      for (let offset = tagIndex; offset <= tagSegments.length; offset++) {
        if (visit(patternIndex + 1, offset)) return true
      }
      return false
    }
    if (tagIndex >= tagSegments.length) return false
    const tagSegment = tagSegments[tagIndex]
    const matches = segment.matcher?.test(tagSegment) || segment.prefixMatcher?.test(tagSegment)
    return !!matches && visit(patternIndex + 1, tagIndex + 1)
  }
  return visit(0, 0)
}

/** Unicode normalization shared by fields, tags, and literal text matching. */
export function normalizeQueryValue(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/** Prefix matching used by enum-like fields while their value is being typed. */
export function matchesProgressiveEnumValue(candidate: string, typedValue: string): boolean {
  const typed = normalizeQueryValue(typedValue)
  return typed.length > 0 && normalizeQueryValue(candidate).startsWith(typed)
}

/** Prefer an exact property key, otherwise resolve a typed prefix to candidate keys. */
export function resolvePropertyNameCandidates(names: readonly string[], requestedName: string): string[] {
  const normalized = normalizeQueryValue(requestedName)
  if (!normalized) return []
  const exact = names.find(name => normalizeQueryValue(name) === normalized)
  return exact ? [exact] : names.filter(name => normalizeQueryValue(name).startsWith(normalized))
}

/** Unquoted string property equality is prefix-aware for live, incremental typing. */
export function matchesProgressivePropertyString(actual: string, expected: string, rawValue: string): boolean {
  const raw = rawValue.trim()
  const containsGlob = hasUnescapedWildcard(raw)
  if (!raw || raw.startsWith('"') || containsGlob || raw.startsWith('^') || raw.startsWith('~')) return false
  return normalizeQueryValue(actual).startsWith(normalizeQueryValue(expected))
}

/** Match string-valued property comparisons, preserving progressive typing by default. */
export function matchesPropertyString(actual: string, expected: string, rawValue: string): boolean {
  const raw = rawValue.trim()
  if (!raw || raw.startsWith('"')) return false
  const candidate = normalizeQueryValue(actual)
  if (raw.startsWith('^')) return candidate.startsWith(normalizeQueryValue(expected.slice(1)))
  if (raw.startsWith('~')) return candidate.includes(normalizeQueryValue(expected.slice(1)))
  if (hasUnescapedWildcard(raw)) return globPatternMatches(actual, raw, normalizeQueryValue)
  return candidate.startsWith(normalizeQueryValue(expected))
}

export function compareTypedValues(actual: unknown, expected: unknown, operator: ComparisonOperator): boolean {
  if (actual === undefined) return false
  const left = scalarComparable(actual)
  const right = scalarComparable(expected)
  if (operator === '~=') {
    if (typeof left === 'string' && typeof right === 'string') {
      return normalizeQueryValue(left).includes(normalizeQueryValue(right))
    }
    return String(left).toLocaleLowerCase().includes(String(right).toLocaleLowerCase())
  }
  if (operator === '=' || operator === '!=') {
    // String equality is normalized and case-insensitive like the other text
    // fields. Numeric, boolean, and null comparisons remain type-strict; do not
    // make a frontmatter number match merely because its text representation
    // happens to look the same.
    const equal = typeof left === 'string' && typeof right === 'string'
      ? normalizeQueryValue(left) === normalizeQueryValue(right)
      : typeof left === typeof right && left === right
    return operator === '=' ? equal : !equal
  }
  if (left === null || right === null) return false
  if (typeof left === 'number' && typeof right === 'number') {
    if (operator === '>') return left > right
    if (operator === '>=') return left >= right
    if (operator === '<') return left < right
    return left <= right
  }
  // Lexicographic ordering is only defined for strings; booleans and mixed
  // types do not acquire an accidental ordering through String(...) coercion.
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const normalizedLeft = normalizeQueryValue(left)
  const normalizedRight = normalizeQueryValue(right)
  if (operator === '>') return normalizedLeft > normalizedRight
  if (operator === '>=') return normalizedLeft >= normalizedRight
  if (operator === '<') return normalizedLeft < normalizedRight
  return normalizedLeft <= normalizedRight
}

function scalarComparable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}(?:$|T)/u.test(value) && !Number.isNaN(Date.parse(value))) return new Date(value).getTime()
    return value.normalize('NFKC').trim()
  }
  return value
}

export function isQueryNodeLeaf(node: QueryNode): node is TextNode | TextQueryNode | PhraseNode | LiteralNode | FieldNode | PropertyNode | TagNode {
  return node.kind !== 'binary' && node.kind !== 'not'
}
