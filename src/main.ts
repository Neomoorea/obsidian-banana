import {
  App,
  Notice,
  Platform,
  Plugin,
  type PluginManifest,
  TFile,
} from 'obsidian'
import {
  BananaInFileModal,
  BananaVaultModal,
} from './components/modals'
import {
  getDefaultSettings,
  loadSettings,
  SettingsTab,
  showExcerpt,
} from './settings'
import type { BananaSettings } from './settings/utils'
import { isCacheEnabled } from './settings/utils'
import { saveSettings } from './settings/utils'
import { isPluginDisabled } from './settings/utils'
import {
  eventBus,
  EventNames,
  indexingStep,
  IndexingStepType,
  type TextExtractorApi,
  type AIImageAnalyzerAPI,
} from './globals'
import { notifyOnIndexed, registerAPI } from './tools/api'
import { Database } from './database'
import { SearchEngine } from './search/search-engine'
import { DocumentsRepository } from './repositories/documents-repository'
import { logVerbose } from './tools/utils'
import { NotesIndexer } from './notes-indexer'
import { TextProcessor } from './tools/text-processing'
import { EmbedsRepository } from './repositories/embeds-repository'
import { SearchHistory } from './search/search-history'

export default class BananaPlugin extends Plugin {
  // FIXME: fix the type
  public apiHttpServer: null | any = null
  public settings: BananaSettings

  public readonly documentsRepository: DocumentsRepository
  public readonly embedsRepository: EmbedsRepository
  public readonly database: Database

  public readonly notesIndexer: NotesIndexer
  public readonly textProcessor: TextProcessor
  public readonly searchEngine: SearchEngine
  public readonly searchHistory: SearchHistory

  private ribbonButton?: HTMLElement
  private initializedSuccessfully = false
  private refreshIndexCallback?: (ev: FocusEvent) => any

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest)
    // Keep plugin-specific initialization in the constructor body so startup
    // errors can be surfaced to the user instead of appearing only as
    // Obsidian's generic "Failed to load plugin" message. Preserve the original
    // initialization order because repositories reference this plugin object.
    try {
      this.settings = getDefaultSettings(this.app)
      this.embedsRepository = new EmbedsRepository(this)
      this.database = new Database(this)
      this.notesIndexer = new NotesIndexer(this)
      this.textProcessor = new TextProcessor(this)
      this.searchEngine = new SearchEngine(this)
      this.searchHistory = new SearchHistory(this)
      this.documentsRepository = new DocumentsRepository(this)
    } catch (error) {
      reportStartupFailure('constructor', error)
      throw error
    }
  }

  async onload(): Promise<void> {
    try {
      await this.initializePlugin()
    } catch (error) {
      reportStartupFailure('onload', error)
      throw error
    }
  }

  private async initializePlugin(): Promise<void> {
    this.settings = await loadSettings(this)
    this.addSettingTab(new SettingsTab(this))

    if (!Platform.isMobile) {
      import('./tools/api-server')
        .then(m => (this.apiHttpServer = m.getServer(this)))
        .catch(e => {
          console.error('Banana - Failed to load API server', e)
        })
    }

    if (isPluginDisabled(this.app)) {
      console.debug('Plugin disabled')
      return
    }

    await cleanOldCacheFiles(this.app)
    await this.database.clearOldDatabases()

    registerAPI(this)

    const settings = this.settings
    if (settings.ribbonIcon) {
      this.addRibbonButton()
    }

    eventBus.disable('vault')
    eventBus.disable('infile')
    eventBus.on('global', EventNames.ToggleExcerpts, () => {
      showExcerpt.set(!settings.showExcerpt)
    })

    // Commands to display Banana modals
    this.addCommand({
      id: 'show-modal',
      name: 'Vault search',
      callback: () => {
        new BananaVaultModal(this).open()
      },
    })

    this.addCommand({
      id: 'show-modal-infile',
      name: 'In-file search',
      editorCallback: (_editor, view) => {
        if (view.file) {
          new BananaInFileModal(this, view.file).open()
        }
      },
    })

    const searchEngine = this.searchEngine

    this.app.workspace.onLayoutReady(async () => {
      // Listeners to keep the search index up-to-date
      this.registerEvent(
        this.app.vault.on('create', async file => {
          if (!(file instanceof TFile)) return
          if (this.notesIndexer.isFileIndexable(file.path)) {
            logVerbose('Indexing new file', file.path)
            try {
              await searchEngine.addFromPaths([file.path])
            } catch (e) {
              console.error('Banana - Error indexing new file', e)
            }
            this.embedsRepository.refreshEmbedsForNote(file.path)
          }
        })
      )
      this.registerEvent(
        this.app.vault.on('delete', file => {
          if (!(file instanceof TFile)) return
          logVerbose('Removing file', file.path)
          this.documentsRepository.removeDocument(file.path)
          searchEngine.removeFromPaths([file.path])
          this.embedsRepository.removeFile(file.path)
        })
      )
      this.registerEvent(
        this.app.vault.on('modify', async file => {
          if (!(file instanceof TFile)) return
          if (this.notesIndexer.isFileIndexable(file.path)) {
            this.notesIndexer.flagNoteForReindex(file)
          }
          this.embedsRepository.refreshEmbedsForNote(file.path)
        })
      )
      this.registerEvent(
        this.app.vault.on('rename', async (file, oldPath) => {
          if (!(file instanceof TFile)) return
          if (this.notesIndexer.isFileIndexable(file.path)) {
            logVerbose('Renaming file', file.path)
            this.documentsRepository.removeDocument(oldPath)
            await this.documentsRepository.addDocument(file.path)

            searchEngine.removeFromPaths([oldPath])
            await searchEngine.addFromPaths([file.path])

            this.embedsRepository.renameFile(oldPath, file.path)
          }
        })
      )

      this.refreshIndexCallback = this.notesIndexer.refreshIndex.bind(
        this.notesIndexer
      )
      addEventListener('blur', this.refreshIndexCallback!)

      await this.executeFirstLaunchTasks()
      await this.populateIndex()

      if (this.apiHttpServer && settings.httpApiEnabled) {
        this.apiHttpServer.listen(settings.httpApiPort)
      }
    })
    this.initializedSuccessfully = true
  }

  async executeFirstLaunchTasks(): Promise<void> {
    const code = '1.0.0'
    // if (settings.welcomeMessage !== code && getTextExtractor()) {
    //   const welcome = new DocumentFragment()
    //   welcome.createSpan({}, span => {
    //     span.innerHTML = `🔎 Banana can now index .docx and .xlsx documents. Don't forget to update Text Extractor and enable the toggle in Banana settings.`
    //   })
    //   new Notice(welcome, 20_000)
    // }
    this.settings.welcomeMessage = code
    await this.saveData(this.settings)
  }

  async onunload(): Promise<void> {
    // @ts-ignore
    delete globalThis['banana']

    if (this.refreshIndexCallback) {
      removeEventListener('blur', this.refreshIndexCallback)
    }

    // Avoid clearing the database as a side effect of a failed partial load.
    // Cache cleanup is retained for normal production unloads.
    if (this.initializedSuccessfully && process.env.NODE_ENV === 'production') {
      try {
        await this.database.clearCache()
      } catch (error) {
        console.warn('Banana - Could not clear the cache during unload', error)
      }
    }
    // The API server is loaded asynchronously and may still be null when the
    // plugin unloads (or is disabled on mobile).
    this.apiHttpServer?.close?.()
  }

  addRibbonButton(): void {
    this.ribbonButton = this.addRibbonIcon('search', 'Banana', _evt => {
      new BananaVaultModal(this).open()
    })
  }

  removeRibbonButton(): void {
    if (this.ribbonButton) {
      this.ribbonButton.parentNode?.removeChild(this.ribbonButton)
    }
  }

  /**
   * Plugin dependency - Chs Patch for Chinese word segmentation
   * @returns
   */
  public getChsSegmenter(): any | undefined {
    return (this.app as any).plugins?.plugins?.['cm-chs-patch']
  }

  /**
   * Plugin dependency - Text Extractor
   * @returns
   */
  public getTextExtractor(): TextExtractorApi | undefined {
    return (this.app as any).plugins?.plugins?.['text-extractor']?.api
  }

  /**
   * Plugin dependency - Ai Image Analyzer
   * @returns
   */
  public getAIImageAnalyzer(): AIImageAnalyzerAPI | undefined {
    return (this.app as any).plugins?.plugins?.['ai-image-analyzer']?.api
  }

  private async populateIndex(): Promise<void> {
    console.time('Indexing total time')
    indexingStep.set(IndexingStepType.ReadingFiles)
    const files = this.app.vault
      .getFiles()
      .filter(f => this.notesIndexer.isFileIndexable(f.path))
    console.debug(`${files.length} files total`)
    console.debug(`Cache is ${isCacheEnabled() ? 'enabled' : 'disabled'}`)
    // Map documents in the background
    // Promise.all(files.map(f => cacheManager.addToLiveCache(f.path)))

    const searchEngine = this.searchEngine
    if (isCacheEnabled()) {
      console.time('Loading index from cache')
      indexingStep.set(IndexingStepType.LoadingCache)
      const hasCache = await searchEngine.loadCache()
      if (hasCache) {
        console.timeEnd('Loading index from cache')
      }
    }

    const diff = searchEngine.getDocumentsToReindex(
      files.map(f => ({ path: f.path, mtime: f.stat.mtime }))
    )

    if (isCacheEnabled()) {
      if (diff.toAdd.length) {
        console.debug(
          'Total number of files to add/update: ' + diff.toAdd.length
        )
      }
      if (diff.toRemove.length) {
        console.debug(
          'Total number of files to remove: ' + diff.toRemove.length
        )
      }
    }

    if (diff.toAdd.length >= 1000 && isCacheEnabled()) {
      new Notice(
        `${diff.toAdd.length} files need to be indexed. Obsidian may experience stutters and freezes during the process`,
        10_000
      )
    }

    indexingStep.set(IndexingStepType.IndexingFiles)
    searchEngine.removeFromPaths(diff.toRemove.map(o => o.path))
    await searchEngine.addFromPaths(diff.toAdd.map(o => o.path))

    if ((diff.toRemove.length || diff.toAdd.length) && isCacheEnabled()) {
      indexingStep.set(IndexingStepType.WritingCache)

      // Disable settings.useCache while writing the cache, in case it freezes
      const cacheEnabled = this.settings.useCache
      if (cacheEnabled && !this.settings.DANGER_forceSaveCache) {
        this.settings.useCache = false
        await saveSettings(this)
      }

      // Write the cache
      await this.database.writeMinisearchCache()
      await this.embedsRepository.writeToCache()

      // Re-enable settings.caching
      if (cacheEnabled) {
        this.settings.useCache = true
        await saveSettings(this)
      }
    }

    console.timeEnd('Indexing total time')
    if (diff.toAdd.length >= 1000 && isCacheEnabled()) {
      new Notice(`Your files have been indexed.`)
    }
    indexingStep.set(IndexingStepType.Done)
    notifyOnIndexed()
  }
}

/**
 * Best-effort startup diagnostics for failures that Obsidian otherwise reports
 * only as "Failed to load plugin". This is deliberately independent of verbose
 * logging because users may be unable to see DevTools output during startup.
 */
function reportStartupFailure(phase: 'constructor' | 'onload', error: unknown): void {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error)
  const stack = error instanceof Error && error.stack ? error.stack : detail
  console.error(`Banana startup failed during ${phase}`, error)
  try {
    const fragment = document.createDocumentFragment()
    const wrapper = document.createElement('div')
    const heading = document.createElement('strong')
    heading.textContent = `Banana startup failed (${phase})`
    wrapper.appendChild(heading)
    const message = document.createElement('p')
    message.textContent = detail
    wrapper.appendChild(message)
    const stackElement = document.createElement('pre')
    stackElement.textContent = stack.slice(0, 900)
    wrapper.appendChild(stackElement)
    fragment.appendChild(wrapper)
    new Notice(fragment, 20_000)
  } catch {
    // Keep the original exception as the one propagated to Obsidian.
  }
}

/**
 * Read the files and feed them to Minisearch
 */

async function cleanOldCacheFiles(app: App) {
  const toDelete = [
    `${app.vault.configDir}/plugins/banana/searchIndex.json`,
    `${app.vault.configDir}/plugins/banana/notesCache.json`,
    `${app.vault.configDir}/plugins/banana/notesCache.data`,
    `${app.vault.configDir}/plugins/banana/searchIndex.data`,
    `${app.vault.configDir}/plugins/banana/historyCache.json`,
    `${app.vault.configDir}/plugins/banana/pdfCache.data`,
  ]
  for (const item of toDelete) {
    if (await app.vault.adapter.exists(item)) {
      try {
        await app.vault.adapter.remove(item)
      } catch (e) {}
    }
  }
}
