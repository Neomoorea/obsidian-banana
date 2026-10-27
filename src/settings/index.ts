// noinspection CssUnresolvedCustomProperty
import { App, Plugin, PluginSettingTab, Setting } from 'obsidian'
import { writable } from 'svelte/store'
import { K_DISABLE_BANANA, RecencyCutoff } from '../globals'
import type BananaPlugin from '../main'
import { enableVerboseLogging } from '../tools/utils'
import { injectSettingsBehavior } from './settings-behavior'
import { injectSettingsDanger } from './settings-danger'
import { injectSettingsHttp } from './settings-http'
import { injectSettingsIndexing } from './settings-indexing'
import { injectSettingsUserInterface } from './settings-ui'
import { injectSettingsWeighting } from './settings-weighting'
import { type BananaSettings, saveSettings } from './utils'
import { DEFAULT_LITERAL_PREFIXES } from '../search/query-language'
import { migrateQueryPrefillPreference } from './query-prefill-migration'

/**
 * A store to reactively toggle the `showExcerpt` setting on the fly
 */
export const showExcerpt = writable(false)

export class SettingsTab extends PluginSettingTab {
  plugin: BananaPlugin

  constructor(plugin: BananaPlugin) {
    super(plugin.app, plugin)
    this.plugin = plugin

    showExcerpt.subscribe(async v => {
      settings.showExcerpt = v
      await saveSettings(this.plugin)
    })
  }

  display(): void {
    const { containerEl } = this

    containerEl.empty()

    if (this.app.loadLocalStorage(K_DISABLE_BANANA) == '1') {
      const span = containerEl.createEl('span')
      const strong = document.createElement('strong')
      strong.style.color = 'var(--text-accent)'
      strong.textContent = '⚠️ BANANA IS DISABLED ⚠️'
      span.appendChild(strong)
    }

    // Settings main title
    containerEl.createEl('h1', { text: 'Banana' })

    injectSettingsIndexing(this.plugin, settings, containerEl)
    containerEl.createEl('hr')
    injectSettingsBehavior(this.plugin, settings, containerEl)
    containerEl.createEl('hr')
    injectSettingsUserInterface(this.plugin, settings, containerEl)
    containerEl.createEl('hr')
    injectSettingsWeighting(this.plugin, settings, containerEl, () => {
      this.display()
    })
    containerEl.createEl('hr')
    injectSettingsHttp(this.plugin, settings, containerEl)
    containerEl.createEl('hr')
    injectSettingsDanger(this.plugin, settings, containerEl)
    containerEl.createEl('hr')

    //#region Debugging

    new Setting(containerEl).setName('Debugging').setHeading()

    new Setting(containerEl)
      .setName('Enable verbose logging')
      .setDesc(
        'Adds a LOT of logs for debugging purposes. You also need to enable "Verbose" logging in the console to see these logs.'
      )
      .addToggle(toggle =>
        toggle.setValue(settings.verboseLogging).onChange(async v => {
          settings.verboseLogging = v
          enableVerboseLogging(v)
          await saveSettings(this.plugin)
        })
      )

    //#endregion Debugging

    //#region Danger Zone

    //#endregion Danger Zone
  }
}

export function getDefaultSettings(app: App): BananaSettings {
  return {
    useCache: true,
    hideExcluded: false,
    recencyBoost: RecencyCutoff.Disabled,
    downrankedFoldersFilters: [] as string[],
    ignoreDiacritics: true,
    ignoreArabicDiacritics: false,
    indexedFileTypes: [] as string[],
    indexFilesWithoutExtension: false,
    displayTitle: '',
    PDFIndexing: false,
    officeIndexing: false,
    imagesIndexing: false,
    aiImageIndexing: false,
    unsupportedFilesIndexing: 'default',
    splitCamelCase: false,
    vimLikeNavigationShortcut: app.vault.getConfig('vimMode') as boolean,

    ribbonIcon: true,
    showExcerpt: true,
    maxEmbeds: 5,
    renderLineReturnInExcerpts: true,
    showCreateButton: false,
    highlight: true,
    showPreviousQueryResults: false,
    queryPrefillBehaviorVersion: 1,
    simpleSearch: false,
    tokenizeUrls: false,
    fuzziness: '1',

    weightBasename: 10,
    weightDirectory: 7,
    weightH1: 6,
    weightH2: 5,
    weightH3: 4,
    weightUnmarkedTags: 2,
    weightCustomProperties: [] as { name: string; weight: number }[],

    httpApiEnabled: false,
    httpApiPort: '51361',
    httpApiNotice: true,

    welcomeMessage: '',
    queryFieldAliases: {},
    queryLiteralPrefixes: [...DEFAULT_LITERAL_PREFIXES],
    queryModalPosition: null,
    queryModalSize: null,
    queryModalGeometryVersion: 0,
    verboseLogging: false,

    DANGER_httpHost: null,
    DANGER_forceSaveCache: false,
  }
}

export let settings: BananaSettings

// /**
//  * @deprecated
//  */
// export function getSettings(): BananaSettings {
//   if (!settings) {
//     settings = Object.assign({}, getDefaultSettings()) as BananaSettings
//   }
//   return settings
// }

export async function loadSettings(
  plugin: Plugin
): Promise<BananaSettings> {
  const storedSettings = (await plugin.loadData()) as Partial<BananaSettings> | null
  settings = Object.assign(
    {},
    getDefaultSettings(plugin.app),
    storedSettings,
  )
  if (migrateQueryPrefillPreference(settings, storedSettings)) {
    await plugin.saveData(settings)
  }
  showExcerpt.set(settings.showExcerpt)
  enableVerboseLogging(settings.verboseLogging)
  return settings
}
