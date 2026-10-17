import Dexie from 'dexie'
import type { AsPlainObject } from 'minisearch'
import type { DocumentRef } from './globals'
import { Notice } from 'obsidian'
import type BananaPlugin from './main'

export class Database extends Dexie {
  public static readonly dbVersion = 10
  searchHistory!: Dexie.Table<{ id?: number; query: string }, number>
  minisearch!: Dexie.Table<
    {
      date: string
      paths: DocumentRef[]
      data: AsPlainObject
    },
    string
  >
  embeds!: Dexie.Table<{ embedded: string; referencedBy: string[] }, string>

  constructor(private plugin: BananaPlugin) {
    super(Database.getDbName(plugin.app.appId))
    // Database structure
    this.version(Database.dbVersion).stores({
      searchHistory: '++id',
      minisearch: 'date',
      embeds: 'embedded',
    })
  }

  private static getDbName(appId: string) {
    return 'banana/cache/' + appId
  }

  //#endregion Table declarations

  public async getMinisearchCache(): Promise<{
    paths: DocumentRef[]
    data: AsPlainObject
  } | null> {
    try {
      const cachedIndex = (await this.plugin.database.minisearch.toArray())[0]
      return cachedIndex
    } catch (e) {
      new Notice(
        'Banana - Cache missing or invalid. Some freezes may occur while Banana indexes your vault.'
      )
      console.error('Banana - Error while loading Minisearch cache')
      console.error(e)
      return null
    }
  }

  public async writeMinisearchCache(): Promise<void> {
    const minisearchJson = this.plugin.searchEngine.getSerializedMiniSearch()
    const paths = this.plugin.searchEngine.getSerializedIndexedDocuments()
    const database = this.plugin.database
    await database.minisearch.clear()
    await database.minisearch.add({
      date: new Date().toISOString(),
      paths,
      data: minisearchJson,
    })
    console.debug('Banana - Search cache written')
  }

  /**
   * Deletes Banana databases that have an older version than the current one
   */
  public async clearOldDatabases(): Promise<void> {
    // IDBFactory.databases() is not available in every embedded Chromium
    // runtime. A failure here must not reject Plugin.onload(): Dexie can still
    // open/upgrade the current database itself.
    const factory = window.indexedDB
    if (!factory || typeof factory.databases !== 'function') return

    let databases: IDBDatabaseInfo[]
    try {
      databases = await factory.databases()
    } catch (error) {
      console.warn('Banana - Could not inspect old IndexedDB databases', error)
      return
    }

    const toDelete = databases.filter(
      db =>
        db.name === Database.getDbName(this.plugin.app.appId) &&
        // Version multiplied by 10: https://github.com/Dexie/Dexie.js/issues/59
        db.version !== Database.dbVersion * 10
    )
    if (toDelete.length) {
      console.debug('Banana - Those IndexedDB databases will be deleted:')
      for (const db of toDelete) {
        if (!db.name) continue
        try {
          factory.deleteDatabase(db.name)
        } catch (error) {
          console.warn(`Banana - Could not delete old database "${db.name}"`, error)
        }
      }
    }
  }

  public async clearCache() {
    await this.minisearch.clear()
    await this.embeds.clear()
    new Notice('Banana - Cache cleared. Please restart Obsidian.')
  }
}
