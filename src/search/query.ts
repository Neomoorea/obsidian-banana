import { removeDiacritics } from '../tools/utils'
import { parse } from 'search-query-parser'
import { parseQueryLanguage, type ParsedQueryLanguage, type QueryFieldAliases, type QueryNode } from './query-language'

const keywords = ['ext', 'path'] as const

type Keywords = {
  [K in typeof keywords[number]]?: string[]
} & { text: string[] }

export class Query {
  query: Keywords & {
    exclude: Keywords
  }
  #inQuotes: string[]
  public readonly rawText: string
  public readonly language: ParsedQueryLanguage

  constructor(text = '', options: { ignoreDiacritics: boolean, ignoreArabicDiacritics: boolean, fieldAliases?: QueryFieldAliases, literalPrefixes?: readonly string[] }) {
    this.rawText = text
    this.language = parseQueryLanguage(text, { fieldAliases: options.fieldAliases, literalPrefixes: options.literalPrefixes })
    if (options.ignoreDiacritics) {
      text = removeDiacritics(text, options.ignoreArabicDiacritics)
    }
    const parsed = parse(text.toLowerCase(), {
      tokenize: true,
      keywords: keywords as unknown as string[],
    }) as unknown as typeof this.query

    // Default values
    parsed.text = parsed.text ?? []
    parsed.exclude = parsed.exclude ?? { text: [] }
    parsed.exclude.text = parsed.exclude.text ?? []
    if (!Array.isArray(parsed.exclude.text)) {
      parsed.exclude.text = [parsed.exclude.text]
    }
    // Remove empty excluded strings
    parsed.exclude.text = parsed.exclude.text.filter(o => o.length)

    // Make sure that all fields are string[]
    for (const k of keywords) {
      const v = parsed[k]
      if (v) {
        parsed[k] = Array.isArray(v) ? v : [v]
      }
      const e = parsed.exclude[k]
      if (e) {
        parsed.exclude[k] = Array.isArray(e) ? e : [e]
      }
    }
    this.query = parsed

    // Extract keywords starting with a dot...
    const ext = this.query.text
      .filter(o => o.startsWith('.'))
      .map(o => o.slice(1))
    // add them to the ext field...
    this.query.ext = [...new Set([...ext, ...(this.query.ext ?? [])])]
    // and remove them from the text field
    this.query.text = this.query.text.filter(o => !o.startsWith('.'))

    // Get strings in quotes, and remove the quotes
    this.#inQuotes =
      text.match(/"([^"]+)"/g)?.map(o => o.replace(/"/g, '')) ?? []
    // In free text, the characters that are query syntax elsewhere are searched exactly as typed: a word
    // with a `*` in it, or with one of ( ) : = ^ ~ & | inside it (`LLM*`, `foo(bar`, `foo:bar`, `R&D`).
    // Without this the tokenizer drops the punctuation, so `AI LLM*` would match like `AI LLM` and
    // `foo(bar` would also return `foo:bar`. A leading hyphen marks an exclusion and is left alone.
    for (const word of text.replace(/"[^"]*"/g, ' ').split(/\s+/)) {
      if (!word.startsWith('-') && /\*|\S[():=^~&|]\S/.test(word)) {
        this.#inQuotes.push(word.replace(/\\(["\\*:=^~()])/g, '$1'))
      }
    }
  }

  public isEmpty(): boolean {
    if (this.language.isAdvanced) return !this.rawText.trim()
    for (const k of keywords) {
      if (this.query[k]?.length) {
        return false
      }
      if (this.query.text.length) {
        return false
      }
    }
    return true
  }

  public segmentsToStr(): string {
    return this.query.text.join(' ')
  }

  public getTags(): string[] {
    if (this.language.isAdvanced && this.language.root) {
      const tags: string[] = []
      const visit = (node: QueryNode): void => {
        if (node.kind === 'tag') tags.push(`#${node.pattern}`)
        else if (node.kind === 'field' && node.field === 'tag') tags.push(`#${node.value}`)
        else if (node.kind === 'binary') { visit(node.left); visit(node.right) }
        else if (node.kind === 'not') visit(node.child)
      }
      visit(this.language.root)
      return [...new Set(tags)]
    }
    return this.query.text.filter(o => o.startsWith('#'))
  }

  public getTagsWithoutHashtag(): string[] {
    return this.getTags().map(o => o.replace(/^#/, ''))
  }

  /**
   *
   * @returns An array of strings that are in quotes
   */
  public getExactTerms(): string[] {
    if (this.language.isAdvanced && this.language.root) {
      const exactTerms: string[] = []
      const visit = (node: QueryNode): void => {
        if (node.kind === 'phrase' || node.kind === 'literal') exactTerms.push(node.value)
        else if (node.kind === 'textQuery') exactTerms.push(...node.phraseValues)
        else if (node.kind === 'binary') { visit(node.left); visit(node.right) }
        else if (node.kind === 'not') visit(node.child)
      }
      visit(this.language.root)
      return [...new Set(exactTerms.filter(Boolean).map(value => value.toLowerCase()))]
    }
    return [
      ...new Set(
        [
          ...this.query.text.filter(o => o.split(' ').length > 1),
          ...this.#inQuotes,
        ].map(str => str.toLowerCase())
      ),
    ]
  }

  /** Values whose textual locations are meaningful to highlight in results. */
  public getFieldHighlightTerms(): string[] {
    if (!this.language.isAdvanced || !this.language.root) return []
    const terms: string[] = []
    const textFields = new Set(['title', 'file', 'path', 'folder', 'alias', 'heading', 'line', 'task', 'linksto', 'linkedby', 'embed', 'contains', 'block', 'section', 'outlinks', 'inlinks'])
    const visit = (node: QueryNode): void => {
      if (node.kind === 'field' && textFields.has(node.field) && node.value.trim()) terms.push(node.value)
      else if (node.kind === 'property') {
        terms.push(node.name)
        if (typeof node.value === 'string' && node.value) terms.push(node.value)
      } else if (node.kind === 'binary') { visit(node.left); visit(node.right) }
      else if (node.kind === 'not') visit(node.child)
    }
    visit(this.language.root)
    return [...new Set(terms)]
  }

  public getBestStringForExcerpt(): string {
    // Prefer exact phrase/literal text over metadata syntax in advanced queries.
    const exactTerms = this.getExactTerms()
    if (exactTerms.length) return [...exactTerms].sort((a, b) => b.length - a.length)[0] ?? ''
    const fieldTerms = this.getFieldHighlightTerms()
    if (fieldTerms.length) return [...fieldTerms].sort((a, b) => b.length - a.length)[0] ?? ''
    // Otherwise, retain Banana's existing excerpt behavior.
    if (this.#inQuotes.length) {
      return this.#inQuotes.sort((a, b) => b.length - a.length)[0] ?? ''
    }
    return this.segmentsToStr()
  }
}
