import MiniSearch, {
  type AsPlainObject,
  type Options,
  type SearchResult,
} from 'minisearch'
import {
  RecencyCutoff,
  type DocumentRef,
  type IndexedDocument,
  type ResultNote,
  type ResultProvenance,
  type SearchMatch,
} from '../globals'

import {
  chunkArray,
  countError,
  logVerbose,
  removeDiacritics,
} from '../tools/utils'
import { getAllTags, Notice, TFile, type CachedMetadata } from 'obsidian'
import { Query } from './query'
import { sortBy } from 'es-toolkit/compat'
import type BananaPlugin from '../main'
import { Tokenizer } from './tokenizer'
import {
  collectLiteralSyntaxSpellings,
  compareTypedValues,
  combineMatchProvenance,
  compileTagPattern,
  matchTagPattern,
  normalizeQueryValue,
  resolvePropertyNameCandidates,
  matchesPropertyString,
  matchesProgressiveEnumValue,
  parseByteSize,
  parseDate,
  type BooleanOperator,
  type FieldNode,
  type PropertyNode,
  type QueryNode,
} from './query-language'
import { buildRenderedText, buildSourceMappedText, normalizeMappedText, matchStructuredText, type NormalizedMappedText } from './rendered-text'
import { filterMatchesToScopes, findScopedTextMatches, intersectScopeEvidence, mergeScopeEvidence, type ScopeEvidence } from './scoped-text'
import { maskQuerySyntaxOccurrences } from './literal-matching'
import { findTagFrontmatterSourceMatch } from './tag-source-match'
import { completeTrailingToken } from './autocomplete'
import { overlaySemanticEvidence } from './match-provenance'
import { TextCandidateIndex, type CandidateTextViews, type CandidateView } from './text-candidate-index'

export class SearchEngine {
  private tokenizer: Tokenizer
  private minisearch: MiniSearch
  /** Map<path, mtime> */
  private indexedDocuments: Map<string, number> = new Map()
  private advancedContextCache = new Map<string, QueryDocumentContext>()
  private textCandidateIndex = new TextCandidateIndex()
  private textCandidateIndexReady = false
  private textCandidateIndexSignature = ''
  private dirtyCandidatePaths = new Set<string>()

  // private previousResults: SearchResult[] = []
  // private previousQuery: Query | null = null

  constructor(protected plugin: BananaPlugin) {
    this.tokenizer = new Tokenizer(plugin)
    this.minisearch = new MiniSearch(this.getOptions())
    // Metadata can change independently of the file's mtime (for example when
    // Obsidian refreshes frontmatter or link resolution), so invalidate cached
    // query contexts on both vault and metadata lifecycle events.
    this.plugin.registerEvent(this.plugin.app.metadataCache.on('changed', file => {
      this.invalidateAdvancedCaches(file.path)
    }))
    this.plugin.registerEvent(this.plugin.app.vault.on('modify', file => {
      this.invalidateAdvancedCaches(file.path)
    }))
    this.plugin.registerEvent(this.plugin.app.vault.on('create', file => {
      this.invalidateAdvancedCaches(file.path)
    }))
    this.plugin.registerEvent(this.plugin.app.vault.on('delete', file => {
      this.invalidateAdvancedCaches(file.path)
    }))
    this.plugin.registerEvent(this.plugin.app.vault.on('rename', (file, oldPath) => {
      this.invalidateAdvancedCaches(oldPath)
      this.invalidateAdvancedCaches(file.path)
    }))
  }

  /**
   * Return true if the cache is valid
   */
  async loadCache(): Promise<boolean> {
    await this.plugin.embedsRepository.loadFromCache()
    const cache = await this.plugin.database.getMinisearchCache()
    if (cache) {
      this.minisearch = await MiniSearch.loadJSAsync(
        cache.data,
        this.getOptions()
      )
      this.indexedDocuments = new Map(cache.paths.map(o => [o.path, o.mtime]))
      this.textCandidateIndex.clear()
      this.textCandidateIndexReady = false
      this.textCandidateIndexSignature = this.getNormalizationSignature()
      this.dirtyCandidatePaths.clear()
      return true
    }
    console.log('Banana - No cache found')
    return false
  }

  /**
   * Returns the list of documents that need to be reindexed or removed,
   * either because they are new, have been modified, or have been deleted
   * @param docs
   */
  getDocumentsToReindex(docs: DocumentRef[]): {
    toAdd: DocumentRef[]
    toRemove: DocumentRef[]
  } {
    const docsMap = new Map(docs.map(d => [d.path, d.mtime]))

    const toAdd = docs.filter(
      d =>
        !this.indexedDocuments.has(d.path) ||
        this.indexedDocuments.get(d.path) !== d.mtime
    )

    const toRemove = [...this.indexedDocuments]
      .filter(
        ([path, mtime]) => !docsMap.has(path) || docsMap.get(path) !== mtime
      )
      .map(o => ({ path: o[0], mtime: o[1] }))
    return { toAdd, toRemove }
  }

  /**
   * Add notes/PDFs/images to the search index
   * @param paths
   */
  public async addFromPaths(paths: string[]): Promise<void> {
    paths.forEach(path => this.advancedContextCache.delete(path))
    logVerbose('Adding files', paths)
    let documents = (
      await Promise.all(
        paths.map(
          async path => await this.plugin.documentsRepository.getDocument(path)
        )
      )
    ).filter(d => !!d?.path)
    logVerbose('Sorting documents to first index markdown')
    // Index markdown files first
    documents = sortBy(documents, d => (d.path.endsWith('.md') ? 0 : 1))

    // If a document is already added, discard it
    this.removeFromPaths(
      documents.filter(d => this.indexedDocuments.has(d.path)).map(d => d.path)
    )

    // Split the documents in smaller chunks to add them to minisearch
    const chunkedDocs = chunkArray(documents, 500)
    for (const docs of chunkedDocs) {
      logVerbose('Indexing into search engine', docs)
      // Update the list of indexed docs
      docs.forEach(doc => this.indexedDocuments.set(doc.path, doc.mtime))

      // Discard files that may have been already added (though it shouldn't happen)
      const alreadyAdded = docs.filter(doc => this.minisearch.has(doc.path))
      this.removeFromPaths(alreadyAdded.map(o => o.path))

      // Build compact character n-gram candidates alongside the ranked index;
      // punctuation/literal queries can then avoid traversing the whole vault on
      // every keystroke. MiniSearch still supplies ordinary-text relevance.
      docs.forEach(doc => this.indexTextCandidateDocument(doc))

      // Add docs to minisearch
      await this.minisearch.addAllAsync(docs)

      // A file may have been deleted while we were reading/indexing it.
      // Its delete handler ran before the doc was in minisearch,
      // so it couldn't discard it.
      // Remove vanished files now to avoid keeping stale entries.
      const deleted = docs.filter(
        doc => !this.plugin.app.vault.getAbstractFileByPath(doc.path)
      )
      if (deleted.length) {
        this.removeFromPaths(deleted.map(doc => doc.path))
      }
    }
  }

  /**
   * Discard a document from minisearch
   * @param paths
   */
  public removeFromPaths(paths: string[]): void {
    paths.forEach(p => {
      this.indexedDocuments.delete(p)
      this.advancedContextCache.delete(p)
      this.textCandidateIndex.remove(p)
      this.dirtyCandidatePaths.delete(p)
    })
    // Make sure to not discard a file that we don't have
    const existing = paths.filter(p => this.minisearch.has(p))
    this.minisearch.discardAll(existing)
  }

  private getNormalizationSignature(): string {
    return `${this.plugin.settings.ignoreDiacritics}:${this.plugin.settings.ignoreArabicDiacritics}`
  }

  private normalizeIndexCharacter(value: string): string {
    const withoutDiacritics = this.plugin.settings.ignoreDiacritics
      ? removeDiacritics(value, this.plugin.settings.ignoreArabicDiacritics)
      : value
    return withoutDiacritics.normalize('NFKC').toLocaleLowerCase()
  }

  private normalizeIndexText(value: string, rendered = false): string {
    const mapped = rendered ? buildRenderedText(value) : buildSourceMappedText(value)
    return normalizeMappedText(mapped, character => this.normalizeIndexCharacter(character)).text
  }

  private candidateViews(path: string, content: string, title: string): CandidateTextViews {
    return {
      raw: this.normalizeIndexText(content),
      rendered: this.normalizeIndexText(content, true),
      metadata: this.normalizeIndexText(`${path} ${title}`),
    }
  }

  private indexTextCandidateDocument(doc: IndexedDocument): void {
    const signature = this.getNormalizationSignature()
    if (this.textCandidateIndexSignature !== signature) {
      this.textCandidateIndex.clear()
      this.textCandidateIndexSignature = signature
      this.textCandidateIndexReady = false
    }
    this.textCandidateIndex.add(doc.path, this.candidateViews(doc.path, doc.content ?? '', doc.displayTitle || doc.basename || doc.path))
    this.dirtyCandidatePaths.delete(doc.path)
  }

  private invalidateAdvancedCaches(path?: string): void {
    if (!path) {
      this.advancedContextCache.clear()
      this.textCandidateIndex.clear()
      this.textCandidateIndexReady = false
      this.dirtyCandidatePaths.clear()
      return
    }
    this.advancedContextCache.delete(path)
    this.textCandidateIndex.remove(path)
    this.dirtyCandidatePaths.add(path)
  }

  /** Refresh only the changed document when Obsidian updates a file. The base
   * index intentionally defers its own reindexing until focus for performance,
   * but structured/rendered searches must see current content and metadata. */
  private async getFreshDocument(path: string): Promise<IndexedDocument | undefined> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return undefined
    let doc = await this.plugin.documentsRepository.getDocument(path)
    if (!doc || doc.mtime !== file.stat.mtime) {
      await this.plugin.documentsRepository.addDocument(path)
      doc = await this.plugin.documentsRepository.getDocument(path)
    }
    return doc?.path ? doc : undefined
  }

  private async ensureTextCandidateIndex(): Promise<void> {
    const signature = this.getNormalizationSignature()
    if (this.textCandidateIndexSignature !== signature) {
      this.textCandidateIndex.clear()
      this.textCandidateIndexSignature = signature
      this.textCandidateIndexReady = false
    }
    if (!this.textCandidateIndexReady) {
      const paths = [...this.indexedDocuments.keys()]
      await Promise.all(paths.map(async path => {
        if (this.textCandidateIndex.has(path)) return
        const doc = await this.getFreshDocument(path)
        if (doc?.path) this.indexTextCandidateDocument(doc)
      }))
      this.textCandidateIndexReady = true
    }
    // Once built, refresh only the paths invalidated by file/metadata events;
    // do not rebuild the entire vault for every edit.
    const dirtyPaths = [...this.dirtyCandidatePaths]
    await Promise.all(dirtyPaths.map(async path => {
      this.textCandidateIndex.remove(path)
      if (!this.indexedDocuments.has(path)) {
        this.dirtyCandidatePaths.delete(path)
        return
      }
      const doc = await this.getFreshDocument(path)
      if (doc?.path) this.indexTextCandidateDocument(doc)
      else this.dirtyCandidatePaths.delete(path)
    }))
  }

  private async getTextCandidatePaths(needle: string, views: readonly CandidateView[]): Promise<Set<string>> {
    await this.ensureTextCandidateIndex()
    return this.textCandidateIndex.find(needle, views)
  }

  /**
   * Return MiniSearch's highest-ranked completion for ordinary free text.
   * Structured query contexts are completed by the input component instead.
   */
  public getAutocompleteSuggestion(query: string): string | undefined {
    const value = query.trimEnd()
    if (!value || /[:()"']/u.test(value)) return undefined
    try {
      // MiniSearch may suggest a whole multiword query and append a second
      // copy of a partially typed token (for example, "machine learn learning").
      // Only complete the final token; keep the already typed prefix intact.
      const suggestions = this.minisearch.autoSuggest(value)
      const contextual = completeTrailingToken(value, suggestions.map(item => item.suggestion))
      if (contextual) return contextual

      // Some MiniSearch versions return no extension for a multiword query
      // even though its final token has a valid prefix completion. Retry only
      // the final token, then splice that completion back onto the original
      // typed prefix.
      const lastToken = value.slice(value.lastIndexOf(' ') + 1)
      if (lastToken && lastToken !== value) {
        const tokenSuggestions = this.minisearch.autoSuggest(lastToken)
        return completeTrailingToken(value, tokenSuggestions.map(item => item.suggestion))
      }
      return undefined
    } catch (error: unknown) {
      logVerbose('Autocomplete suggestion failed', error)
      return undefined
    }
  }

  /**
   * Searches the index for the given query,
   * and returns an array of raw results
   */
  public async search(
    query: Query,
    options: { prefixLength: number; singleFilePath?: string; limit?: number; forceLegacy?: boolean; fields?: string[] }
  ): Promise<SearchResult[]> {
    if (query.language.isAdvanced && !options.forceLegacy) return this.searchAdvanced(query, options)
    const settings = this.plugin.settings
    if (query.isEmpty()) {
      // this.previousResults = []
      // this.previousQuery = null
      return []
    }

    logVerbose('=== New search ===')
    logVerbose('Starting search for', query)

    let fuzziness: number
    switch (settings.fuzziness) {
      case '0':
        fuzziness = 0
        break
      case '1':
        fuzziness = 0.1
        break
      default:
        fuzziness = 0.2
        break
    }

    const searchTokens = this.tokenizer.tokenizeForSearch(query.segmentsToStr())
    logVerbose(JSON.stringify(searchTokens, null, 1))
    let results = this.minisearch.search(searchTokens, {
      prefix: term => term.length >= options.prefixLength,
      // length <= 3: no fuzziness
      // length <= 5: fuzziness of 10%
      // length > 5: fuzziness of 20%
      fuzzy: term =>
        term.length <= 3 ? 0 : term.length <= 5 ? fuzziness / 2 : fuzziness,
      boost: {
        basename: settings.weightBasename,
        aliases: settings.weightBasename,
        displayTitle: settings.weightBasename,
        directory: settings.weightDirectory,
        headings1: settings.weightH1,
        headings2: settings.weightH2,
        headings3: settings.weightH3,
        tags: settings.weightUnmarkedTags,
        unmarkedTags: settings.weightUnmarkedTags,
      },
      // The query is already tokenized, don't tokenize again
      tokenize: text => [text],
      fields: options.fields,
      boostDocument(_id, _term, storedFields) {
        if (
          !storedFields?.mtime ||
          settings.recencyBoost === RecencyCutoff.Disabled
        ) {
          return 1
        }
        const mtime = storedFields?.mtime as number
        const now = new Date().valueOf()
        const daysElapsed = (now - mtime) / (24 * 3600_000)

        // Documents boost
        const cutoff = {
          [RecencyCutoff.Day]: -3,
          [RecencyCutoff.Week]: -0.3,
          [RecencyCutoff.Month]: -0.1,
        } as const
        return (
          1 + Math.exp(cutoff[settings.recencyBoost] * (daysElapsed / 1000))
        )
      },
    })

    logVerbose(`Found ${results.length} results`, results)

    // Filter query results to only keep files that match query.query.ext (if any)
    if (query.query.ext?.length) {
      results = results.filter(r => {
        // ".can" should match ".canvas"
        const ext = '.' + r.id.split('.').pop()
        return query.query.ext?.some(e =>
          ext.startsWith(e.startsWith('.') ? e : '.' + e)
        )
      })
    }

    // Filter query results that match the path
    if (query.query.path) {
      results = results.filter(r => {
        const rPath = settings.ignoreDiacritics
          ? removeDiacritics(r.id as string, settings.ignoreArabicDiacritics).toLowerCase()
          : (r.id as string).toLowerCase()
        return query.query.path?.some(p => rPath.includes(p.toLowerCase()))
      })
    }
    if (query.query.exclude.path) {
      results = results.filter(r => {
        const rPath = settings.ignoreDiacritics
          ? removeDiacritics(r.id as string, settings.ignoreArabicDiacritics).toLowerCase()
          : (r.id as string).toLowerCase()
        return !query.query.exclude.path?.some(p => rPath.includes(p.toLowerCase()))
      })
    }

    if (!results.length) {
      return []
    }

    if (options.singleFilePath) {
      return results.filter(r => r.id === options.singleFilePath)
    }

    logVerbose(
      'searching with downranked folders',
      settings.downrankedFoldersFilters
    )

    // Hide or downrank files that are in Obsidian's excluded list
    if (settings.hideExcluded) {
      // Filter the files out
      results = results.filter(
        result =>
          !(
            this.plugin.app.metadataCache.isUserIgnored &&
            this.plugin.app.metadataCache.isUserIgnored(result.id)
          )
      )
    } else {
      // Just downrank them
      results.forEach(result => {
        if (
          this.plugin.app.metadataCache.isUserIgnored &&
          this.plugin.app.metadataCache.isUserIgnored(result.id)
        ) {
          result.score /= 10
        }
      })
    }

    // Extract tags from the query
    const tags = query.getTags()

    for (const result of results) {
      const path = result.id as string
      if (settings.downrankedFoldersFilters.length > 0) {
        // downrank files that are in folders listed in the downrankedFoldersFilters
        let downrankingFolder = false
        settings.downrankedFoldersFilters.forEach(filter => {
          if (path.startsWith(filter)) {
            // we don't want the filter to match the folder sources, e.g.
            // it needs to match a whole folder name
            if (path === filter || path.startsWith(filter + '/')) {
              logVerbose('searching with downranked folders in path: ', path)
              downrankingFolder = true
            }
          }
        })
        if (downrankingFolder) {
          result.score /= 10
        }
        const pathParts = path.split('/')
        const pathPartsLength = pathParts.length
        for (let i = 0; i < pathPartsLength; i++) {
          const pathPart = pathParts[i]
          if (settings.downrankedFoldersFilters.includes(pathPart)) {
            result.score /= 10
            break
          }
        }
      }

      const metadata = this.plugin.app.metadataCache.getCache(path)
      if (metadata) {
        // Boost custom properties
        for (const { name, weight } of settings.weightCustomProperties) {
          const values = metadata?.frontmatter?.[name]
          if (values && result.terms.some(t => values.includes(t))) {
            logVerbose(`Boosting field "${name}" x${weight} for ${path}`)
            result.score *= weight
          }
        }
      }

      // Boost results whose title (basename or displayTitle) starts with the full query
      const queryStr = query.segmentsToStr().toLowerCase()
      if (queryStr) {
        let title = (path.split('/').pop() ?? '').replace(/\.[^.]+$/, '')
        if (metadata && settings.displayTitle) {
          if (settings.displayTitle === '#heading') {
            title = metadata?.headings?.find(h => h.level === 1)?.heading ?? title
          } else {
            title = (metadata?.frontmatter?.[settings.displayTitle] as string | undefined) ?? title
          }
        }
        if (title.toLowerCase().startsWith(queryStr)) {
          logVerbose(`Exact title prefix match: ${path}`)
          result.score *= 100
        }
      }

      // Put the results with tags on top
      for (const tag of tags) {
        if ((result.tags ?? []).includes(tag)) {
          result.score *= 100
        }
      }
    }
    logVerbose('Sorting and limiting results')

    // Sort results and keep the 50 best
    results = results.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 50)

    logVerbose('Filtered results:', results)

    if (results.length) logVerbose('First result:', results[0])

    const documents = await Promise.all(
      results.map(async result => {
        const doc = await this.plugin.documentsRepository.getDocument(result.id)
        if (!doc) {
          console.warn(`Banana - Note "${result.id}" not in the live cache`)
          countError(true)
        }
        return doc
      })
    )

    // If the search query contains quotes, filter out results that don't have the exact match
    const exactTerms = query.getExactTerms()
    if (exactTerms.length) {
      logVerbose('Filtering with quoted terms: ', exactTerms)
      const normalizePhrase = (value: string): string => {
        const diacriticNormalized = this.plugin.settings.ignoreDiacritics
          ? removeDiacritics(value, this.plugin.settings.ignoreArabicDiacritics)
          : value
        return normalizeQueryValue(diacriticNormalized)
      }
      results = results.filter(r => {
        const document = documents.find(d => d.path === r.id)
        const title = normalizePhrase(document?.path ?? '')
        const content = normalizePhrase(document?.content ?? '')
        return exactTerms.every(q => {
          const phrase = normalizePhrase(q)
          return content.includes(phrase) || title.includes(phrase)
        })
      })
    }

    // If the search query contains exclude terms, filter out results that have them
    const exclusions = query.query.exclude.text
    if (exclusions.length) {
      logVerbose('Filtering with exclusions')
      results = results.filter(r => {
        const content = (
          documents.find(d => d.path === r.id)?.content ?? ''
        ).toLowerCase()
        return exclusions.every(q => !content.includes(q))
      })
    }

    logVerbose('Deduping')
    // FIXME:
    // Dedupe results to avoid duplicate rows from overlapping index fields.
    results = results.filter(
      (result, index, arr) => arr.findIndex(t => t.id === result.id) === index
    )

    // this.previousQuery = query
    // this.previousResults = results

    return results
  }

  /** Evaluate a typed query AST. Text leaves still delegate to MiniSearch. */
  private async searchAdvanced(
    query: Query,
    options: { prefixLength: number; singleFilePath?: string; limit?: number }
  ): Promise<SearchResult[]> {
    const language = query.language
    if (!language.root || language.diagnostics.some(diagnostic => diagnostic.severity === 'error')) return []

    const universe = [...this.indexedDocuments.keys()].filter(path => {
      if (options.singleFilePath && path !== options.singleFilePath) return false
      return this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile
    })
    const universeSet = new Set(universe)
    type AdvancedResult = SearchResult & { provenance?: ResultProvenance; sourceMatches?: SearchMatch[] }
    type Hit = { result: AdvancedResult; semantic: boolean; literal: boolean; score: number; sourceMatches: SearchMatch[]; scopes: ScopeEvidence[] }
    type HitMap = Map<string, Hit>
    // Provenance describes every kind of evidence present in a returned note,
    // not only the Boolean branch that happened to admit it. For example, a
    // note matching `tag:#work` and the `"CNN"` arm of an OR must be Both even
    // if it doesn't match the other text arm. Query truth remains governed by
    // the AST; this set affects labels only, never membership.
    const semanticEvidencePaths = new Set<string>()
    const recordSemanticEvidence = (hits: HitMap): void => {
      for (const [path, hit] of hits) if (hit.semantic) semanticEvidencePaths.add(path)
    }
    const normalizeSearchText = (value: string): string => {
      const normalizedDiacritics = this.plugin.settings.ignoreDiacritics
        ? removeDiacritics(value, this.plugin.settings.ignoreArabicDiacritics)
        : value
      return normalizeQueryValue(normalizedDiacritics)
    }
    const contextPromises = new Map<string, Promise<QueryDocumentContext | undefined>>()
    const getContext = (path: string): Promise<QueryDocumentContext | undefined> => {
      const cached = contextPromises.get(path)
      if (cached) return cached
      const promise = this.getAdvancedContext(path)
      contextPromises.set(path, promise)
      return promise
    }
    const getAllContexts = async (): Promise<QueryDocumentContext[]> => {
      const contexts = await Promise.all(universe.map(getContext))
      return contexts.filter((context): context is QueryDocumentContext => !!context)
    }
    // A query's own spelling is a literal match, not evidence that its operand
    // occurs independently in the document. Mask that exact syntax while
    // evaluating text-backed predicates, preserving every source offset. This
    // is what keeps `section:1` in prose Literal-only while `## 1` remains a
    // genuine Semantic match for the section predicate.
    const withoutQuerySyntax = (context: QueryDocumentContext, syntax: string): QueryDocumentContext => {
      const content = maskQuerySyntaxOccurrences(context.content, syntax)
      if (content === context.content) return context
      const characterNormalizer = (character: string): string => this.normalizeIndexCharacter(character)
      return {
        ...context,
        content,
        normalizedContent: normalizeMappedText(buildSourceMappedText(content), characterNormalizer),
        normalizedRenderedContent: normalizeMappedText(buildRenderedText(content), characterNormalizer),
      }
    }
    // Search body/raw-source, body/rendered-text, path, and title separately so
    // phrase hits cannot bridge one field into another. Rendered body offsets map
    // back to raw Markdown source positions for jump/highlight behavior.
    const findBodyMatch = (context: QueryDocumentContext, needle: string, includeRendered = true): SearchMatch[] => {
      const normalizedNeedle = normalizeSearchText(needle)
      if (!normalizedNeedle) return []
      const rawMapped = context.normalizedContent
      const rawOffset = rawMapped.text.indexOf(normalizedNeedle)
      if (rawOffset >= 0) {
        const sourceStart = rawMapped.sourceOffsets[rawOffset] ?? 0
        const lastIndex = Math.min(rawMapped.sourceOffsets.length - 1, rawOffset + normalizedNeedle.length - 1)
        const sourceEnd = rawMapped.sourceEnds[lastIndex] ?? sourceStart + 1
        const sourceMatch = context.content.slice(sourceStart, Math.max(sourceStart + 1, sourceEnd))
        return [{ match: sourceMatch || needle, offset: sourceStart }]
      }
      if (includeRendered) {
        const mapped = context.normalizedRenderedContent
        const renderedOffset = mapped.text.indexOf(normalizedNeedle)
        if (renderedOffset >= 0) {
          const sourceStart = mapped.sourceOffsets[renderedOffset] ?? 0
          const lastIndex = Math.min(mapped.sourceOffsets.length - 1, renderedOffset + normalizedNeedle.length - 1)
          const sourceEnd = mapped.sourceEnds[lastIndex] ?? sourceStart + 1
          const sourceMatch = context.content.slice(sourceStart, Math.max(sourceStart + 1, sourceEnd))
          return [{ match: sourceMatch || needle, offset: sourceStart }]
        }
      }
      return []
    }
    const makeHit = (path: string, provenance: ResultProvenance, score = 0, terms: string[] = [], sourceMatches: SearchMatch[] = [], scopes: ScopeEvidence[] = []): Hit => {
      const normalizedProvenance = { semantic: !!provenance.semantic, literal: !!provenance.literal }
      return {
        result: { id: path, score, terms, queryTerms: terms, match: {}, provenance: normalizedProvenance, sourceMatches } as AdvancedResult,
        semantic: normalizedProvenance.semantic,
        literal: normalizedProvenance.literal,
        score,
        sourceMatches,
        scopes,
      }
    }
    const mergeSourceMatches = (...groups: SearchMatch[][]): SearchMatch[] => {
      const unique = new Map<string, SearchMatch>()
      for (const match of groups.flat()) unique.set(`${match.offset}\u0000${match.match}`, match)
      return [...unique.values()].sort((left, right) => left.offset - right.offset)
    }
    const evaluateScopedField = async (node: FieldNode, kind: ScopeEvidence['kind']): Promise<HitMap> => {
      const hits: HitMap = new Map()
      const mode = node.matchMode ?? 'substring'
      for (const sourceContext of await getAllContexts()) {
        const context = withoutQuerySyntax(sourceContext, node.raw)
        const findings = findScopedTextMatches(context.content, node.value, kind, mode, value => this.normalizeIndexCharacter(value), node.globPattern)
        if (!findings.length) continue
        const scopes = findings.map(finding => finding.scope)
        const sourceMatches = findings.map(finding => finding.sourceMatch).filter((match): match is SearchMatch => !!match)
        hits.set(context.path, makeHit(context.path, { semantic: true, literal: false }, 0, [], mergeSourceMatches(sourceMatches), scopes))
      }
      return hits
    }
    const union = (left: HitMap, right: HitMap): HitMap => {
      const combined: HitMap = new Map(left)
      for (const [path, rightHit] of right) {
        const leftHit = combined.get(path)
        if (!leftHit) { combined.set(path, rightHit); continue }
        const provenance = combineMatchProvenance('OR',
          { semantic: leftHit.semantic, literal: leftHit.literal },
          { semantic: rightHit.semantic, literal: rightHit.literal },
        ).provenance
        const score = Math.max(leftHit.score, rightHit.score)
        const terms = [...new Set([...leftHit.result.terms, ...rightHit.result.terms])]
        combined.set(path, makeHit(path, provenance, score, terms, mergeSourceMatches(leftHit.sourceMatches, rightHit.sourceMatches), mergeScopeEvidence(leftHit.scopes, rightHit.scopes)))
      }
      return combined
    }
    const intersection = (left: HitMap, right: HitMap): HitMap => {
      const combined: HitMap = new Map()
      for (const [path, leftHit] of left) {
        const rightHit = right.get(path)
        if (!rightHit) continue
        const scopes = intersectScopeEvidence(leftHit.scopes, rightHit.scopes)
        if (scopes === null) continue
        const provenance = combineMatchProvenance('AND',
          { semantic: leftHit.semantic, literal: leftHit.literal },
          { semantic: rightHit.semantic, literal: rightHit.literal },
        ).provenance
        const score = Math.max(leftHit.score, rightHit.score)
        const terms = [...new Set([...leftHit.result.terms, ...rightHit.result.terms])]
        combined.set(path, makeHit(path, provenance, score, terms, filterMatchesToScopes(mergeSourceMatches(leftHit.sourceMatches, rightHit.sourceMatches), scopes), scopes))
      }
      return combined
    }
    const negativeProvenance = (_node: QueryNode): ResultProvenance => {
      // A negated query is a semantic predicate over absence, even when its
      // positive operand would produce literal text matches.
      return { semantic: true, literal: false }
    }
    const complement = (hits: HitMap, provenance: ResultProvenance): HitMap => {
      const combined: HitMap = new Map()
      for (const path of universeSet) {
        if (!hits.has(path)) combined.set(path, makeHit(path, provenance))
      }
      return combined
    }
    const textLeaf = async (value: string, phrase = false, contentOnly = false, syntaxToMask?: string, includeRenderedText = true): Promise<HitMap> => {
      const normalized = normalizeSearchText(value)
      if (!normalized) return new Map()
      // Punctuation-only searches use the same literal provenance as ordinary
      // free-text searches; semantic is reserved for interpreted predicates.
      if (!phrase && !/[\p{L}\p{N}]/u.test(value)) {
        const hits: HitMap = new Map()
        const candidatePaths = await this.getTextCandidatePaths(normalized, contentOnly ? (includeRenderedText ? ['raw', 'rendered'] : ['raw']) : ['raw', 'rendered', 'metadata'])
        const candidates = [...candidatePaths].filter(path => universeSet.has(path))
        const contexts = await Promise.all(candidates.map(getContext))
        for (const sourceContext of contexts) {
          if (!sourceContext) continue
          const context = syntaxToMask ? withoutQuerySyntax(sourceContext, syntaxToMask) : sourceContext
          const sourceMatches = findBodyMatch(context, value, includeRenderedText)
          const otherHit = !contentOnly && [context.file.path, context.title].some(text => normalizeSearchText(text).includes(normalized))
          if (sourceMatches.length || otherHit) {
            hits.set(context.path, makeHit(context.path, { semantic: false, literal: true }, 0, [], sourceMatches))
          }
        }
        return hits
      }
      // Feed phrase contents as ordinary terms to MiniSearch so it can produce
      // a ranked candidate superset. The cached raw/rendered verifier below
      // enforces adjacency; quoting here would make Banana's legacy filter
      // reject matches separated by Markdown delimiters such as **bold**.
      const settings = this.plugin.settings
      const textQuery = new Query(value, {
        ignoreDiacritics: settings.ignoreDiacritics,
        ignoreArabicDiacritics: settings.ignoreArabicDiacritics,
      })
      const ranked = await this.search(textQuery, {
        prefixLength: options.prefixLength,
        singleFilePath: options.singleFilePath,
        limit: Number.POSITIVE_INFINITY,
        forceLegacy: true,
        fields: contentOnly ? ['content'] : undefined,
      })
      const rankedByPath = new Map<string, SearchResult>(ranked.map(result => [String(result.id), result] as const))
      // Preserve MiniSearch's ranked/fuzzy results, then union an index-backed
      // exact-substring pass over raw and rendered text. MiniSearch can discard
      // a phrase such as `a bbb a` before verification because short tokens are
      // weak/ignored; the candidate index recovers Markdown-rendered matches
      // without a vault-wide scan and the verifier rejects n-gram false positives.
      const candidatePaths = await this.getTextCandidatePaths(
        normalized,
        contentOnly ? (includeRenderedText ? ['raw', 'rendered'] : ['raw']) : ['raw', 'rendered', 'metadata'],
      )
      const candidateUniverse = new Set<string>([...rankedByPath.keys(), ...candidatePaths])
      const hits: HitMap = new Map()
      for (const path of candidateUniverse) {
        if (!universeSet.has(path)) continue
        const sourceContext = await getContext(path)
        if (!sourceContext) continue
        const context = syntaxToMask ? withoutQuerySyntax(sourceContext, syntaxToMask) : sourceContext
        const sourceMatches = findBodyMatch(context, normalized, includeRenderedText)
        const otherHit = !contentOnly && [context.file.path, context.title].some(text => normalizeSearchText(text).includes(normalized))
        const rankedResult = rankedByPath.get(path)
        // Non-phrase ordinary searches keep all MiniSearch matches. Candidate
        // index hits are included only when the actual contiguous text exists.
        if (phrase && !sourceMatches.length && !otherHit) continue
        // For a structured content predicate, don't retain a MiniSearch hit
        // that was contributed solely by the predicate's own literal spelling.
        if (syntaxToMask && !sourceMatches.length && !otherHit) continue
        if (!phrase && !rankedResult && !sourceMatches.length && !otherHit) continue
        hits.set(path, makeHit(
          path,
          { semantic: false, literal: true },
          rankedResult?.score ?? 0,
          rankedResult?.terms ?? [],
          sourceMatches,
        ))
      }
      return hits
    }
    const literalLeaf = async (value: string, contentOnly = false): Promise<HitMap> => {
      if (!value.length) return new Map()
      const needle = normalizeSearchText(value)
      if (!needle) return new Map()
      const hits: HitMap = new Map()
      const candidatePaths = await this.getTextCandidatePaths(needle, contentOnly ? ['raw'] : ['raw', 'metadata'])
      const candidates = [...candidatePaths].filter(path => universeSet.has(path))
      const contexts = await Promise.all(candidates.map(getContext))
      for (const context of contexts) {
        if (!context) continue
        const sourceMatches = findBodyMatch(context, needle, false)
        const otherHit = !contentOnly && [context.file.path, context.title].some(text => normalizeSearchText(text).includes(needle))
        if (sourceMatches.length || otherHit) hits.set(context.path, makeHit(context.path, { semantic: false, literal: true }, 0, [], sourceMatches))
      }
      return hits
    }
    const tagLeaf = async (pattern: string, exact = false): Promise<HitMap> => {
      const compiled = compileTagPattern(pattern, { exact })
      if (!compiled) return new Map()
      const hits: HitMap = new Map()
      for (const context of await getAllContexts()) {
        const matchingTags = context.tags
          .filter(tag => matchTagPattern(compiled, tag))
          .map(tag => `#${tag}`)
        if (matchingTags.length) {
          // Use the visible source occurrence when one exists; frontmatter-only
          // metadata matches remain valid without inventing a body highlight.
          const sourceMatches = matchingTags
            .map(tag => findTagFrontmatterSourceMatch(context.content, tag.replace(/^#/u, '')) ?? findBodyMatch(context, tag, false)[0])
            .filter((match): match is SearchMatch => !!match)
          hits.set(context.path, makeHit(context.path, { semantic: true, literal: false }, 0, matchingTags, sourceMatches))
        }
      }
      return hits
    }
    const evaluateField = async (node: FieldNode): Promise<HitMap> => {
      if (node.field === 'block' || node.field === 'section') {
        return evaluateScopedField(node, node.field)
      }
      if (node.field === 'content') {
        const rawFieldValue = node.raw.slice(node.raw.indexOf(':') + 1).trimStart()
        const isPhrase = rawFieldValue.startsWith('"')
        const contentHits = await textLeaf(node.value, isPhrase, true, node.raw, !isPhrase)
        // `content:` is a semantic field predicate even when its value contains
        // only punctuation and therefore bypasses MiniSearch tokenization.
        return new Map<string, Hit>([...contentHits].map(([path, hit]) => [path, makeHit(path, { semantic: true, literal: false }, hit.score, hit.result.terms, hit.sourceMatches)] as const))
      }
      if (node.field === 'contains') {
        const rawFieldValue = node.raw.slice(node.raw.indexOf(':') + 1).trimStart()
        const mode = node.matchMode ?? 'substring'
        if (mode === 'substring' && !rawFieldValue.startsWith('~')) {
          const contentHits = await textLeaf(node.value, true, true, node.raw)
          return new Map<string, Hit>([...contentHits].map(([path, hit]) => [path, makeHit(path, { semantic: true, literal: false }, hit.score, hit.result.terms, hit.sourceMatches)] as const))
        }
        const hits: HitMap = new Map()
        for (const sourceContext of await getAllContexts()) {
          const context = withoutQuerySyntax(sourceContext, node.raw)
          if (!this.matchesField(node, context)) continue
          const sourceMatches = mode === 'exact' || mode === 'prefix' ? findBodyMatch(context, node.value, true) : []
          hits.set(context.path, makeHit(context.path, { semantic: true, literal: false }, 0, [], sourceMatches))
        }
        return hits
      }
      if (node.field === 'tag') return tagLeaf(node.value, node.tagExact)
      const contexts = await getAllContexts()
      const hits: HitMap = new Map()
      for (const sourceContext of contexts) {
        // `line:` and free-form `task:` predicates inspect body text; remove
        // the query's own spelling before evaluating that textual evidence.
        const context = node.field === 'line' || node.field === 'task'
          ? withoutQuerySyntax(sourceContext, node.raw)
          : sourceContext
        if (!this.matchesField(node, context)) continue
        let sourceMatches: SearchMatch[] = []
        if (node.field === 'task') {
          const taskRegex = /^\s*(?:[-*+]\s+)?\[([ xX])\]\s*.*$/gmu
          let match: RegExpExecArray | null
          while ((match = taskRegex.exec(context.content)) !== null) {
            const completed = match[1].toLocaleLowerCase() === 'x'
            const expected = normalizeQueryValue(node.value)
            const taskLine = match[0]
            if ((expected === 'todo' || expected === 'incomplete') ? !completed
              : (expected === 'done' || expected === 'complete') ? completed
              : normalizeQueryValue(taskLine).includes(normalizeQueryValue(node.value))) {
              const offset = match.index + match[0].search(/\[[ xX]\]/u)
              sourceMatches.push({ match: context.content.slice(Math.max(0, offset), match.index + match[0].length), offset: Math.max(0, offset) })
              break
            }
          }
        } else if (node.field === 'heading' || node.field === 'line' || node.field === 'content') {
          sourceMatches = findBodyMatch(context, node.value, true)
        }
        hits.set(context.path, makeHit(context.path, { semantic: true, literal: false }, 0, [], sourceMatches))
      }
      return hits
    }
    const evaluateProperty = async (node: PropertyNode): Promise<HitMap> => {
      const contexts = await getAllContexts()
      const hits: HitMap = new Map()
      for (const context of contexts) {
        const candidateNames = resolvePropertyNameCandidates(Object.keys(context.frontmatter), node.name)
        for (const key of candidateNames) {
          const actual = context.frontmatter[key]
          if (node.comparison === 'exists') {
            hits.set(context.path, makeHit(context.path, { semantic: true, literal: false }))
            break
          }
          if (actual === undefined || node.value === undefined) continue
          const values = Array.isArray(actual) ? actual : [actual]
          const equalsValue = (actualValue: unknown): boolean => {
            // Unquoted property string values share the query match model: an
            // implicit prefix keeps results live while typing; ^ and ~ are
            // explicit prefix/substring modifiers; * and ? enable glob mode.
            // Quoted strings remain strict equality for an intentional exact test.
            if (node.comparison === '=' && typeof actualValue === 'string' && typeof node.value === 'string') {
              const rawValue = node.rawValue ?? ''
              // Quotes make equality exact; unquoted strings get the shared
              // progressive/prefix/substring/glob matcher without falling back
              // to accidental literal equality when a modifier doesn't match.
              if (rawValue.trim().startsWith('"')) return compareTypedValues(actualValue, node.value, '=')
              return matchesPropertyString(actualValue, node.value, rawValue)
            }
            return compareTypedValues(actualValue, node.value, '=')
          }
          const matches = node.comparison === '!='
            ? !values.some(equalsValue)
            : values.some(value => node.comparison === '=' ? equalsValue(value)
              : compareTypedValues(value, node.value, node.comparison as Exclude<PropertyNode['comparison'], 'exists' | '='>))
          if (matches) {
            // Locate the matching frontmatter key in raw source when available.
            // Do not point into body text if the property cannot be mapped.
            let sourceMatches: SearchMatch[] = []
            if (context.content.startsWith('---')) {
              const frontmatterEnd = context.content.indexOf('\n---', 3)
              if (frontmatterEnd >= 0) {
                const frontmatterSource = context.content.slice(0, frontmatterEnd + 1)
                const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
                const keyMatch = new RegExp(`^\\s*['\"]?${escapedKey}['\"]?\\s*:`, 'imu').exec(frontmatterSource)
                if (keyMatch?.index !== undefined) {
                  const lineEnd = context.content.indexOf('\n', keyMatch.index)
                  const end = lineEnd < 0 ? context.content.length : lineEnd
                  sourceMatches = [{ match: context.content.slice(keyMatch.index, end), offset: keyMatch.index }]
                }
              }
            }
            hits.set(context.path, makeHit(context.path, { semantic: true, literal: false }, 0, [], sourceMatches))
            break
          }
        }
      }
      return hits
    }
    const evaluate = async (node: QueryNode, collectEvidence = true): Promise<HitMap> => {
      switch (node.kind) {
        case 'text': return textLeaf(node.value)
        case 'textQuery': return textLeaf(node.query)
        case 'phrase': return textLeaf(node.value, true)
        case 'literal': return literalLeaf(node.value)
        case 'tag': {
          const hits = await tagLeaf(node.pattern)
          if (collectEvidence) recordSemanticEvidence(hits)
          return hits
        }
        case 'field': {
          const hits = await evaluateField(node)
          if (collectEvidence) recordSemanticEvidence(hits)
          return hits
        }
        case 'property': {
          const hits = await evaluateProperty(node)
          if (collectEvidence) recordSemanticEvidence(hits)
          return hits
        }
        case 'not': {
          // Evidence from the positive child must not leak through negation.
          const hits = complement(await evaluate(node.child, false), negativeProvenance(node.child))
          if (collectEvidence) recordSemanticEvidence(hits)
          return hits
        }
        case 'binary': {
          const [left, right] = await Promise.all([
            evaluate(node.left, collectEvidence),
            evaluate(node.right, collectEvidence),
          ])
          switch (node.operator as BooleanOperator) {
            case 'AND': return intersection(left, right)
            case 'OR': return union(left, right)
            case 'XOR': {
              const hits: HitMap = new Map()
              for (const [path, hit] of left) if (!right.has(path)) hits.set(path, hit)
              for (const [path, hit] of right) if (!left.has(path)) hits.set(path, hit)
              return hits
            }
            case 'NAND': return complement(intersection(left, right), negativeProvenance(node))
            case 'NOR': return complement(union(left, right), negativeProvenance(node))
            case 'XNOR': return union(intersection(left, right), intersection(
              complement(left, negativeProvenance(node.left)),
              complement(right, negativeProvenance(node.right)),
            ))
          }
        }
      }
    }

    // Keep the AST's truth evaluation separate from literal evidence for the
    // spelling of structured syntax. Otherwise a body containing `tag:#x`
    // could satisfy the tag operand of `tag:#x AND content:meeting`, causing a
    // false Semantic/Both result and interfering with NOT/NAND/NOR. After the
    // Boolean query is evaluated, independently overlay literal matches for the
    // full query and every structured leaf's original spelling. This works for
    // nested operators and keeps direct source evidence from falsifying a
    // metadata predicate.
    const predicateMatches = await evaluate(language.root)
    const literalSpellings = [...new Set([query.rawText.trim(), ...collectLiteralSyntaxSpellings(language.root)].filter(Boolean))]
    let literalQueryMatches: HitMap = new Map()
    for (const spelling of literalSpellings) {
      literalQueryMatches = union(literalQueryMatches, await literalLeaf(spelling, true))
    }
    const matches = union(predicateMatches, literalQueryMatches)
    // Boolean operators decide whether a note is in the result set. Provenance
    // is then enriched by any independently satisfied positive semantic
    // predicate in the expression, so an OR text branch doesn't erase a real
    // tag/property/field match on the same note.
    overlaySemanticEvidence(matches, semanticEvidencePaths)
    const settings = this.plugin.settings
    const results = [...matches.entries()]
      .map(([path, hit]) => ({ ...hit.result, id: path, score: hit.score, provenance: { semantic: hit.semantic, literal: hit.literal } }))
      .filter(result => !(settings.hideExcluded && this.plugin.app.metadataCache.isUserIgnored?.(String(result.id))))

    // Keep Banana's excluded-file and downranked-folder preferences active
    // for metadata-only and Boolean searches as well as ordinary text searches.
    for (const result of results) {
      const path = String(result.id)
      if (!settings.hideExcluded && this.plugin.app.metadataCache.isUserIgnored?.(path)) result.score /= 10
      for (const filter of settings.downrankedFoldersFilters) {
        if (path === filter || path.startsWith(`${filter}/`)) {
          result.score /= 10
          break
        }
        if (path.split('/').includes(filter)) {
          result.score /= 10
          break
        }
      }
    }
    const provenanceBucket = (result: SearchResult): number => {
      const provenance = (result as SearchResult & { provenance?: ResultProvenance }).provenance
      if (provenance?.literal && !provenance.semantic) return 0 // literal-only first by design
      if (provenance?.semantic && provenance.literal) return 1 // dual-match bucket is explicit
      return 2
    }
    return results
      .sort((left, right) => provenanceBucket(left) - provenanceBucket(right) || right.score - left.score || String(left.id).localeCompare(String(right.id)))
      .slice(0, options.limit ?? 50)
  }

  private async getAdvancedContext(path: string): Promise<QueryDocumentContext | undefined> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return undefined
    const existing = this.advancedContextCache.get(path)
    const normalizationSignature = this.getNormalizationSignature()
    if (existing && existing.mtime === file.stat.mtime && existing.normalizationSignature === normalizationSignature) return existing
    const doc = await this.getFreshDocument(path)
    if (!doc?.path) return undefined
    const cache = this.plugin.app.metadataCache.getFileCache(file)
    const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>
    const tags = (cache ? getAllTags(cache) ?? [] : []).map(tag => tag.replace(/^#/u, '').normalize('NFKC'))
    const links = (cache?.links ?? []).map(link => link.link)
    const embeds = (cache?.embeds ?? []).map(embed => embed.link)
    const resolvedLinks = (this.plugin.app.metadataCache as unknown as {
      resolvedLinks?: Record<string, Record<string, number>>
    }).resolvedLinks ?? {}
    const incoming = Object.entries(resolvedLinks)
      .filter(([, targets]) => !!targets[path])
      .map(([source]) => source)
    const content = doc.content ?? ''
    const characterNormalizer = (value: string): string => this.normalizeIndexCharacter(value)
    const sourceMappedContent = buildSourceMappedText(content)
    const renderedContent = buildRenderedText(content)
    const context: QueryDocumentContext = {
      path, file, cache, frontmatter, tags, links, embeds, incoming,
      content,
      normalizedContent: normalizeMappedText(sourceMappedContent, characterNormalizer),
      normalizedRenderedContent: normalizeMappedText(renderedContent, characterNormalizer),
      normalizationSignature,
      title: doc.displayTitle || file.basename,
      mtime: file.stat.mtime,
    }
    this.advancedContextCache.set(path, context)
    return context
  }

  private matchesField(node: FieldNode, context: QueryDocumentContext): boolean {
    const value = node.value
    const normalizedValue = normalizeQueryValue(value)
    const title = normalizeQueryValue(context.title)
    const extension = context.file.extension.toLocaleLowerCase()
    const content = context.content
    const cache = context.cache
    const frontmatter = context.frontmatter
    const headings = (cache?.headings ?? []).map(heading => heading.heading)
    const aliasesRaw = frontmatter.aliases ?? frontmatter.alias
    const aliases = Array.isArray(aliasesRaw) ? aliasesRaw.map(String) : aliasesRaw === undefined || aliasesRaw === null ? [] : [String(aliasesRaw)]
    const tasks = content.split(/\r?\n/u).filter(line => /^\s*(?:[-*+]\s+)?\[[ xX]\]/u.test(line))
    const todoTasks = tasks.filter(line => /^\s*(?:[-*+]\s+)?\[ \]/u.test(line))
    const doneTasks = tasks.filter(line => /^\s*(?:[-*+]\s+)?\[[xX]\]/u.test(line))
    const linkTargets = this.resolveLinks(context.path, context.links)
    const embedTargets = this.resolveLinks(context.path, context.embeds)
    const tagCount = new Set(context.tags.map(tag => normalizeQueryValue(tag))).size
    const linkCount = new Set(linkTargets.map(target => normalizeQueryValue(target))).size
    const backlinkCount = new Set(context.incoming.map(source => normalizeQueryValue(source))).size
    const wordCount = (content.match(/\S+/gu) ?? []).length
    const emptyBody = context.normalizedRenderedContent.text.trim().length === 0
    const isOrphan = backlinkCount === 0
    const matchesText = (candidate: string): boolean => matchStructuredText(candidate, value, node.matchMode ?? (node.titleMode ?? 'substring'), node.globPattern)
    const rawFieldValue = (node.rawValue ?? node.raw.slice(node.raw.indexOf(':') + 1)).trimStart()
    const rawFieldTokens = rawFieldValue.replace(/^[=^~]/u, '').split(/\s+/u).filter(Boolean)
    const matchesEnum = (candidate: string, typedPart: string, rawPattern?: string): boolean => {
      const rawValue = rawPattern ?? rawFieldValue
      const mode = node.matchMode ?? 'substring'
      // Only a value the parser found to be an unquoted wildcard is a glob; the modifier decides the anchoring.
      const glob = node.globPattern === undefined ? undefined : rawValue.replace(/^[=^~]/u, '').trim()
      if (mode === 'exact' || mode === 'prefix' || mode === 'glob') return matchStructuredText(candidate, typedPart, mode, glob)
      if (glob !== undefined || rawValue.startsWith('~') || rawFieldValue.startsWith('~')) return matchStructuredText(candidate, typedPart, 'substring', glob)
      return matchesProgressiveEnumValue(candidate, typedPart)
    }
    const matchesEnumAlternatives = (candidate: string): boolean => value.split(/\s+/u).filter(Boolean)
      .some((part, index) => matchesEnum(candidate, part, rawFieldTokens[index] ?? part))
    const numericOrDateMatch = (actual: number, expected: string): boolean => {
      if (!expected.trim()) return false
      if (node.field === 'created' || node.field === 'modified') {
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(expected.trim())
        const operator = node.comparison ?? '='
        if (dateOnly && (operator === '=' || operator === '!=')) {
          const dateMatch = new Date(actual).toISOString().slice(0, 10) === expected.trim()
          return operator === '=' ? dateMatch : !dateMatch
        }
      }
      const parsed = node.field === 'size' ? parseByteSize(expected)
        : node.field === 'created' || node.field === 'modified' ? parseDate(expected)
        : Number(expected)
      if (parsed === undefined || Number.isNaN(parsed)) return false
      return compareTypedValues(actual, parsed, node.comparison ?? '=')
    }
    switch (node.field) {
      case 'title': return matchStructuredText(context.title, value, node.matchMode ?? node.titleMode ?? 'substring', node.globPattern)
      case 'file': {
        if ((node.matchMode ?? 'substring') === 'exact' && !/[./\\]/u.test(value)) {
          // Keep `file:md` as a filename substring search, but make the explicit
          // `file:=md` shorthand useful for exact extension matching.
          if (context.file.extension.toLocaleLowerCase() === normalizedValue) return true
        }
        return matchesText(context.file.name)
      }
      case 'path': return matchesText(context.path)
      case 'folder': return matchesText(context.path.split('/').slice(0, -1).join('/'))
      case 'ext': return value.split(/\s+/u).filter(Boolean).some((part, index) => matchesEnum(extension, part.replace(/^\./u, ''), (rawFieldTokens[index] ?? part).replace(/^\./u, '')))
      case 'format': {
        const format = extension === 'md' ? 'markdown'
          : extension === 'pdf' ? 'pdf'
          : ['docx', 'xlsx'].includes(extension) ? 'office'
          : ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) ? 'image'
          : extension === 'canvas' ? 'canvas'
          : ['txt', 'csv', 'json', 'xml', 'html'].includes(extension) ? 'text' : 'other'
        return matchesEnumAlternatives(format)
      }
      case 'type': {
        const type = extension === 'md' ? 'note'
          : ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) ? 'image'
          : extension === 'canvas' ? 'canvas'
          : ['pdf', 'docx', 'xlsx', 'txt', 'csv', 'json', 'xml', 'html'].includes(extension) ? 'document' : 'other'
        return matchesEnumAlternatives(type)
      }
      case 'size': return numericOrDateMatch(context.file.stat.size, value)
      case 'words':
      case 'wordcount': return numericOrDateMatch(wordCount, value)
      case 'tagcount': return numericOrDateMatch(tagCount, value)
      case 'linkcount': return numericOrDateMatch(linkCount, value)
      case 'backlinkcount': return numericOrDateMatch(backlinkCount, value)
      case 'taskcount': return numericOrDateMatch(tasks.length, value)
      case 'created': return numericOrDateMatch(context.file.stat.ctime, value)
      case 'modified': return numericOrDateMatch(context.file.stat.mtime, value)
      case 'alias': return aliases.some(alias => matchesText(alias))
      case 'heading': return headings.some(heading => matchesText(heading))
      case 'line': return content.split(/\r?\n/u).some(line => matchesText(line))
      case 'task': {
        const taskWord = normalizedValue
        if (taskWord === 'todo' || taskWord === 'incomplete') return todoTasks.length > 0
        if (taskWord === 'done' || taskWord === 'complete') return doneTasks.length > 0
        return tasks.some(task => matchesText(task))
      }
      case 'task-todo': {
        if (matchesEnum('false', value)) return todoTasks.length === 0
        if (matchesEnum('true', value)) return todoTasks.length > 0
        return false
      }
      case 'task-done': {
        if (matchesEnum('false', value)) return doneTasks.length === 0
        if (matchesEnum('true', value)) return doneTasks.length > 0
        return false
      }
      case 'linksto': return linkTargets.some(target => matchesText(target))
      case 'outlinks': return linkTargets.some(target => matchesText(target))
      case 'linkedby': return context.incoming.some(source => matchesText(source) || matchesText(source.split('/').pop() ?? source))
      case 'inlinks': return context.incoming.some(source => matchesText(source) || matchesText(source.split('/').pop() ?? source))
      case 'embed': return embedTargets.some(target => matchesText(target))
      case 'contains': return matchesText(context.normalizedRenderedContent.text)
      case 'empty':
        if (matchesEnum('true', value)) return emptyBody
        if (matchesEnum('false', value)) return !emptyBody
        return false
      case 'orphan':
        if (matchesEnum('true', value)) return isOrphan
        if (matchesEnum('false', value)) return !isOrphan
        return false
      case 'is': {
        const states: string[] = []
        if (emptyBody) states.push('empty')
        if (isOrphan) states.push('orphan')
        if (context.tags.length) states.push('tagged')
        else states.push('untagged')
        if (todoTasks.length) states.push('todo')
        if (doneTasks.length) states.push('done')
        if (extension === 'md') states.push('note')
        else states.push('attachment')
        if (linkCount + backlinkCount > 0) states.push('linked')
        else states.push('unlinked')
        return states.some(state => matchesEnum(state, value))
      }
      case 'has': {
        const has = normalizedValue
        const presence: Array<[string[], boolean]> = [
          [['tags', 'tag'], context.tags.length > 0],
          [['aliases', 'alias'], aliases.length > 0],
          [['frontmatter', 'properties', 'property'], Object.keys(frontmatter).length > 0],
          [['headings', 'heading'], headings.length > 0],
          [['tasks', 'task'], tasks.length > 0],
          [['links', 'link'], context.links.length > 0],
          [['embeds', 'embed'], context.embeds.length > 0],
          [['content'], content.trim().length > 0],
        ]
        return presence.some(([names, exists]) => names.some(name => matchesEnum(name, has)) && exists)
      }
      case 'content': return matchesText(content)
      default: return false
    }
  }

  private resolveLinks(sourcePath: string, links: string[]): string[] {
    return links.map(link => {
      const target = this.plugin.app.metadataCache.getFirstLinkpathDest(link, sourcePath)
      return target?.path ?? link
    })
  }

  /**
   * MiniSearch remains the ranked engine for ordinary queries. This supplemental
   * index-backed pass recovers exact visible-text matches that MiniSearch can
   * drop due to short tokens or Markdown delimiters (for example `a **bbb** a`).
   * It does not scan the vault; candidate notes come from the rendered n-gram index.
   */
  private async addRenderedTextMatches(
    query: Query,
    results: SearchResult[],
    singleFilePath?: string,
  ): Promise<SearchResult[]> {
    const root = query.language.root
    if (!root) return results

    // Explicit discriminant checks let TypeScript narrow the AST union. An
    // Array.includes() check only narrows the expression to `string` at runtime;
    // it does not prove which node fields are available here.
    let queryText: string
    switch (root.kind) {
      case 'textQuery':
        queryText = root.query
        break
      case 'text':
      case 'phrase':
        queryText = root.value
        break
      default:
        return results
    }
    const needle = this.normalizeIndexText(queryText, true)
    if (!needle) return results
    const candidates = await this.getTextCandidatePaths(needle, ['rendered'])
    const byPath = new Map(results.map(result => [String(result.id), result]))
    for (const path of candidates) {
      if (singleFilePath && path !== singleFilePath) continue
      const existing = byPath.get(path)
      const context = await this.getAdvancedContext(path)
      if (!context) continue
      const matchAt = context.normalizedRenderedContent.text.indexOf(needle)
      if (matchAt < 0) continue
      const mapped = context.normalizedRenderedContent
      const sourceStart = mapped.sourceOffsets[matchAt] ?? 0
      const finalIndex = Math.min(mapped.sourceOffsets.length - 1, matchAt + needle.length - 1)
      const sourceEnd = mapped.sourceEnds[finalIndex] ?? sourceStart + 1
      const sourceMatch: SearchMatch = {
        match: context.content.slice(sourceStart, Math.max(sourceStart + 1, sourceEnd)),
        offset: sourceStart,
      }
      if (existing) {
        const enriched = existing as SearchResult & { sourceMatches?: SearchMatch[] }
        const allMatches = [...(enriched.sourceMatches ?? []), sourceMatch]
        enriched.sourceMatches = [...new Map(allMatches.map(item => [`${item.offset}:${item.match}`, item])).values()]
      } else {
        const added: SearchResult & { sourceMatches?: SearchMatch[]; provenance?: ResultProvenance } = {
          id: path,
          score: 0,
          terms: [],
          queryTerms: [],
          match: {},
          sourceMatches: [sourceMatch],
          provenance: { semantic: false, literal: true },
        }
        byPath.set(path, added)
      }
    }
    return [...byPath.values()].sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)))
  }

  /**
   * Searches the index, and returns an array of ResultNote objects.
   * If we have the singleFile option set,
   * the array contains a single result from that file
   * @param query
   * @param options
   * @returns
   */
  public async getSuggestions(
    query: Query,
    options?: Partial<{ singleFilePath?: string }>
  ): Promise<ResultNote[]> {
    // Clear highlight regex cache for fresh search
    this.plugin.textProcessor.clearHighlightCache()

    // Get the raw results
    let results: SearchResult[]
    if (this.plugin.settings.simpleSearch) {
      results = await this.search(query, {
        prefixLength: 3,
        singleFilePath: options?.singleFilePath,
      })
    } else {
      results = await this.search(query, {
        prefixLength: 1,
        singleFilePath: options?.singleFilePath,
      })
    }

    const documents = await Promise.all(
      results.map(
        async result =>
          await this.plugin.documentsRepository.getDocument(result.id)
      )
    )

    // Ordinary free text remains ranked by MiniSearch; add only exact rendered
    // body matches that the tokenizer missed, preserving source offsets for open/highlight.
    if (!query.language.isAdvanced) {
      results = await this.addRenderedTextMatches(query, results, options?.singleFilePath)
      // The legacy MiniSearch path is direct text-search evidence, never a
      // structured semantic predicate. Preserve provenance on the existing
      // ranked results as well as any exact rendered-text additions.
      results = results.map(result => ({
        ...result,
        provenance: (result as SearchResult & { provenance?: ResultProvenance }).provenance
          ?? { semantic: false, literal: true },
      }))
    }

    // Re-resolve documents after the supplemental pass may have added matches.
    const finalDocuments = await Promise.all(
      results.map(async result => await this.plugin.documentsRepository.getDocument(result.id))
    )
    documents.splice(0, documents.length, ...finalDocuments)

    // Inject embeds for images, documents, and PDFs
    let total = documents.length
    for (let i = 0; !query.language.isAdvanced && i < total; i++) {
      const doc = documents[i]
      if (!doc) continue

      const embeds = this.plugin.embedsRepository
        .getEmbeds(doc.path)
        .slice(0, this.plugin.settings.maxEmbeds)

      // Inject embeds in the results
      for (const embed of embeds) {
        const newDoc = await this.plugin.documentsRepository.getDocument(embed)
        if (!newDoc?.path) continue
        total++
        documents.splice(i + 1, 0, newDoc)
        results.splice(i + 1, 0, {
          id: newDoc.path,
          score: 0,
          terms: [],
          queryTerms: [],
          match: {},
          isEmbed: true,
        })
        i++ // Increment i to skip the newly inserted document
      }
    }

    // Map the raw results to get usable suggestions
    const resultNotes = results.map((result, index) => {
      logVerbose('Locating matches for', result.id)
      let note = documents.find(d => d.path === result.id)
      if (!note) {
        // throw new Error(`Banana - Note "${result.id}" not indexed`)
        console.warn(`Banana - Note "${result.id}" not in the live cache`)
        note = {
          content: '',
          basename: result.id,
          path: result.id,
        } as IndexedDocument
      }

      // Clean search matches that match quoted expressions,
      // and inject those expressions instead
      const foundWords = [
        // Matching terms from the result,
        // do not necessarily match the query
        ...result.terms,

        // Quoted expressions
        ...query.getExactTerms(),

        // Values used by structured text fields (title, path, links, properties)
        ...query.getFieldHighlightTerms(),

        // Tags, starting with #
        ...query.getTags(),
      ]
      logVerbose('Matching tokens:', foundWords)

      logVerbose('Getting matches locations...')
      // Only compute matches eagerly for first 10 visible results
      // Remaining results compute matches lazily in ResultItemVault on mount
      const directMatches = (result as SearchResult & { sourceMatches?: SearchMatch[] }).sourceMatches ?? []
      const matches = directMatches.length
        ? directMatches
        : index < 10
          ? this.plugin.textProcessor.getMatches(note.content, foundWords, query)
          : []
      logVerbose(`Matches for note "${note.path}"`, matches)
      const resultNote: ResultNote = {
        score: result.score,
        foundWords,
        matches,
        isEmbed: result.isEmbed,
        ...note,
        provenance: (result as SearchResult & { provenance?: ResultProvenance }).provenance,
      }
      return resultNote
    })

    logVerbose('Suggestions:', resultNotes)

    return resultNotes
  }

  /**
   * For cache saving
   */
  public getSerializedMiniSearch(): AsPlainObject {
    return this.minisearch.toJSON()
  }

  /**
   * For cache saving
   */
  public getSerializedIndexedDocuments(): { path: string; mtime: number }[] {
    return Array.from(this.indexedDocuments).map(([path, mtime]) => ({
      path,
      mtime,
    }))
  }

  private getOptions(): Options<IndexedDocument> {
    return {
      tokenize: this.tokenizer.tokenizeForIndexing.bind(this.tokenizer),
      extractField: (doc, fieldName) => {
        if (fieldName === 'directory') {
          // return path without the filename
          const parts = doc.path.split('/')
          parts.pop()
          return parts.join('/')
        }
        return (doc as any)[fieldName]
      },
      processTerm: (term: string) =>
        (this.plugin.settings.ignoreDiacritics
          ? removeDiacritics(term, this.plugin.settings.ignoreArabicDiacritics)
          : term
        ).toLowerCase(),
      idField: 'path',
      fields: [
        'basename',
        // Different from `path`, since `path` is the unique index and needs to include the filename
        'directory',
        'aliases',
        'content',
        'headings1',
        'headings2',
        'headings3',
      ],
      storeFields: ['tags', 'mtime'],
      logger(_level, _message, code) {
        if (code === 'version_conflict') {
          new Notice(
            'Banana - Your index cache may be incorrect or corrupted. If this message keeps appearing, go to Settings to clear the cache.',
            5000
          )
        }
      },
    }
  }
}

interface QueryDocumentContext {
  path: string
  file: TFile
  cache: CachedMetadata | null
  frontmatter: Record<string, unknown>
  tags: string[]
  links: string[]
  embeds: string[]
  incoming: string[]
  content: string
  normalizedContent: NormalizedMappedText
  normalizedRenderedContent: NormalizedMappedText
  normalizationSignature: string
  title: string
  mtime: number
}


