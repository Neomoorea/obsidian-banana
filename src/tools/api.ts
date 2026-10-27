import type { ResultNote } from '../globals'
import { Query } from '../search/query'
import type BananaPlugin from '../main'
import { BananaVaultModal } from '../components/modals'
import { publishPluginApi } from './plugin-api'

type ResultNoteApi = {
  score: number
  vault: string
  path: string
  basename: string
  foundWords: string[]
  matches: SearchMatchApi[]
  excerpt: string
}

export type SearchMatchApi = {
  match: string
  offset: number
}

let notified = false

/**
 * Callbacks to be called when the search index is ready
 */
let onIndexedCallbacks: Array<() => void> = []

function mapResults(
  plugin: BananaPlugin,
  results: ResultNote[]
): ResultNoteApi[] {
  return results.map(result => {
    const { score, path, basename, foundWords, matches, content } = result

    const excerpt = plugin.textProcessor.makeExcerpt(
      content,
      matches[0]?.offset ?? -1
    )

    const res: ResultNoteApi = {
      score,
      vault: plugin.app.vault.getName(),
      path,
      basename,
      foundWords,
      matches: matches.map(match => {
        return {
          match: match.match,
          offset: match.offset,
        }
      }),
      excerpt: excerpt,
    }

    return res
  })
}

export function notifyOnIndexed(): void {
  notified = true
  onIndexedCallbacks.forEach(cb => cb())
}

let registed = false

export function registerAPI(plugin: BananaPlugin): void {
  if (registed) {
    return
  }
  registed = true

  // The new scheme is `obsidian://banana?query=...`.
  plugin.registerObsidianProtocolHandler('banana', params => {
    new BananaVaultModal(plugin, params.query).open()
  })
  // Backward-compatible aliases for existing vault commands and callers.
  plugin.registerObsidianProtocolHandler('omnisearch', params => {
    new BananaVaultModal(plugin, params.query).open()
  })

  const api = getApi(plugin)
  // @ts-ignore - global extension namespace is consumed by existing integrations.
  globalThis['banana'] = api
  // @ts-ignore - preserve the old namespace as a compatibility alias.
  globalThis['omnisearch'] = api
  publishPluginApi(plugin, api)
}

export function getApi(plugin: BananaPlugin) {
  return {
    async search(q: string): Promise<ResultNoteApi[]> {
      const query = new Query(q, {
        ignoreDiacritics: plugin.settings.ignoreDiacritics,
        ignoreArabicDiacritics: plugin.settings.ignoreArabicDiacritics,
        fieldAliases: plugin.settings.queryFieldAliases,
        literalPrefixes: plugin.settings.queryLiteralPrefixes,
      })
      const raw = await plugin.searchEngine.getSuggestions(query)
      return mapResults(plugin, raw)
    },
    registerOnIndexed(cb: () => void): void {
      onIndexedCallbacks.push(cb)
      // Immediately call the callback if the indexing is already ready done
      if (notified) {
        cb()
      }
    },
    unregisterOnIndexed(cb: () => void): void {
      onIndexedCallbacks = onIndexedCallbacks.filter(o => o !== cb)
    },
    refreshIndex: plugin.notesIndexer.refreshIndex,
  }
}
