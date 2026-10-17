import { Notice, Setting } from 'obsidian'
import { showExcerpt } from '.'
import type BananaPlugin from '../main'
import type { BananaSettings } from './utils'
import { FIELD_REGISTRY } from '../search/query-language'
import { htmlDescription, saveSettings } from './utils'

export function injectSettingsUserInterface(
  plugin: BananaPlugin,
  settings: BananaSettings,
  containerEl: HTMLElement
) {
  new Setting(containerEl).setName('User Interface').setHeading()

  // Parser-level field aliases. This deliberately edits a registry rather than
  // rewriting query text, so quoted phrases and literal predicates are safe.
  // Derive the alias target registry from the parser's canonical field list so
  // aliases automatically support every implemented field as the language grows.
  const validFieldNames = new Set(Object.keys(FIELD_REGISTRY))
  const reservedAliasNames = new Set([
    ...validFieldNames, 'literal', 'and', 'or', 'not', 'xor', 'xnor', 'nand', 'nor',
  ])
  const aliasText = Object.entries(settings.queryFieldAliases ?? {})
    .map(([alias, target]) => `${alias}=${target}`)
    .join('\n')
  new Setting(containerEl)
    .setName('Query field aliases')
    .setDesc('Optional aliases for structured-query fields, one per line, for example pt=property. Built-in names cannot be overridden. Aliases are parsed only as field prefixes, not inside quotes or literal: values.')
    .addTextArea(textArea => textArea
      .setPlaceholder('pt=property\nproj=path')
      .setValue(aliasText)
      .onChange(async value => {
        const next: Record<string, string> = {}
        const errors: string[] = []
        for (const [lineIndex, rawLine] of value.split(/\r?\n/u).entries()) {
          const line = rawLine.trim()
          if (!line || line.startsWith('#')) continue
          const match = /^([a-z][a-z0-9-]*)\s*=\s*([a-z][a-z0-9-]*)$/iu.exec(line)
          if (!match) {
            errors.push(`Line ${lineIndex + 1}: use alias=field.`)
            continue
          }
          const alias = match[1].toLocaleLowerCase()
          const target = match[2].toLocaleLowerCase()
          if (reservedAliasNames.has(alias)) {
            errors.push(`Line ${lineIndex + 1}: ${alias} is reserved as a built-in field or Boolean operator.`)
            continue
          }
          if (!validFieldNames.has(target)) {
            errors.push(`Line ${lineIndex + 1}: ${target} is not a supported field.`)
            continue
          }
          if (Object.prototype.hasOwnProperty.call(next, alias)) {
            errors.push(`Line ${lineIndex + 1}: duplicate alias ${alias}.`)
            continue
          }
          next[alias] = target
        }
        if (errors.length) {
          new Notice(`Query aliases were not saved. ${errors[0]}`)
          return
        }
        settings.queryFieldAliases = next
        await saveSettings(plugin)
      }))

  // Show Ribbon Icon
  new Setting(containerEl)
    .setName('Show ribbon button')
    .setDesc('Add a button on the sidebar to open the Vault search modal.')
    .addToggle(toggle =>
      toggle.setValue(settings.ribbonIcon).onChange(async v => {
        settings.ribbonIcon = v
        await saveSettings(plugin)
        if (v) {
          plugin.addRibbonButton()
        } else {
          plugin.removeRibbonButton()
        }
      })
    )

  // Show context excerpt
  new Setting(containerEl)
    .setName('Show excerpts')
    .setDesc(
      'Shows the contextual part of the note that matches the search. Disable this to only show filenames in results.'
    )
    .addToggle(toggle =>
      toggle.setValue(settings.showExcerpt).onChange(async v => {
        showExcerpt.set(v)
      })
    )

  // Show embeds
  new Setting(containerEl)
    .setName('Show embed references')
    .setDesc(
      htmlDescription(`Some results are <a href="https://help.obsidian.md/Linking+notes+and+files/Embed+files">embedded</a> in other notes.<br>
            This setting controls the maximum number of embeds to show in the search results. Set to 0 to disable.<br>
            Also works with Text Extractor for embedded images and documents.`)
    )
    .addSlider(cb => {
      cb.setLimits(0, 10, 1)
        .setValue(settings.maxEmbeds)
        .setDynamicTooltip()
        .onChange(async v => {
          settings.maxEmbeds = v
          await saveSettings(plugin)
        })
    })

  // Keep line returns in excerpts
  new Setting(containerEl)
    .setName('Render line return in excerpts')
    .setDesc('Activate this option to render line returns in result excerpts.')
    .addToggle(toggle =>
      toggle.setValue(settings.renderLineReturnInExcerpts).onChange(async v => {
        settings.renderLineReturnInExcerpts = v
        await saveSettings(plugin)
      })
    )

  // Show "Create note" button
  new Setting(containerEl)
    .setName('Show "Create note" button')
    .setDesc(
      htmlDescription(`Shows a button next to the search input, to create a note.
          Acts the same as the <code>shift ↵</code> shortcut, can be useful for mobile device users.`)
    )
    .addToggle(toggle =>
      toggle.setValue(settings.showCreateButton).onChange(async v => {
        settings.showCreateButton = v
        await saveSettings(plugin)
      })
    )

  // Highlight results
  new Setting(containerEl)
    .setName('Highlight matching words in results')
    .setDesc(
      'Will highlight matching results when enabled. See README for more customization options.'
    )
    .addToggle(toggle =>
      toggle.setValue(settings.highlight).onChange(async v => {
        settings.highlight = v
        await saveSettings(plugin)
      })
    )
}
