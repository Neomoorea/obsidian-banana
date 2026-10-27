import { Notice, Setting, type TextAreaComponent } from 'obsidian'
import { showExcerpt } from '.'
import type BananaPlugin from '../main'
import type { BananaSettings } from './utils'
import { DEFAULT_LITERAL_PREFIXES, FIELD_REGISTRY } from '../search/query-language'
import { htmlDescription, saveSettings } from './utils'

/**
 * Check a text area on every change without nagging: valid content is saved silently, and a problem
 * is announced only when the user finishes a line (Enter) or leaves the field. Typing `pt=prop` on the
 * way to `pt=property` therefore does not raise an error halfway through.
 */
function validateOnLineEnd(textArea: TextAreaComponent, check: (value: string, announce: boolean) => Promise<void>): void {
  const inputEl = textArea.inputEl
  inputEl.addEventListener('keydown', event => {
    // The new line is not in the field yet while the key is being handled.
    if (event.key === 'Enter' && !event.isComposing) window.setTimeout(() => void check(inputEl.value, true), 0)
  })
  inputEl.addEventListener('blur', () => void check(inputEl.value, true))
}

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
      .then(textArea => validateOnLineEnd(textArea, (value, announce) => saveAliases(value, announce)))
      .onChange(value => saveAliases(value, false)))
  async function saveAliases(value: string, announce: boolean): Promise<void> {
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
      if (announce) new Notice(`Query aliases were not saved. ${errors[0]}`)
      return
    }
    settings.queryFieldAliases = next
    await saveSettings(plugin)
  }

  // Words that start like `word:` but are plain text. Anything else of that shape is
  // read as a field name, so a mistyped field (`tga:#x`) is reported instead of searched.
  new Setting(containerEl)
    .setName('Literal text prefixes')
    .setDesc('A word before a colon that is no field name is searched as plain text, with a hint. Words starting with one of these patterns are exempt from the hint. Put one pattern on each line. In a pattern, an asterisk stands for letters, digits, plus, dot and hyphen, and a question mark stands for one letter, so *:// covers every URL scheme and ?:\\ covers every Windows drive. Remove a line and that kind of word gets the hint too.')
    .addTextArea(textArea => textArea
      .setPlaceholder(DEFAULT_LITERAL_PREFIXES.join('\n'))
      .setValue((settings.queryLiteralPrefixes ?? DEFAULT_LITERAL_PREFIXES).join('\n'))
      .then(textArea => validateOnLineEnd(textArea, (value, announce) => saveLiteralPrefixes(value, announce)))
      .onChange(value => saveLiteralPrefixes(value, false)))
  async function saveLiteralPrefixes(value: string, announce: boolean): Promise<void> {
    const next: string[] = []
    const errors: string[] = []
    for (const [lineIndex, rawLine] of value.split(/\r?\n/u).entries()) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      if (/\s/u.test(line) || !line.includes(':')) {
        errors.push(`Line ${lineIndex + 1}: use a pattern without spaces that contains a colon, such as *://.`)
        continue
      }
      if (!next.includes(line)) next.push(line)
    }
    if (errors.length) {
      if (announce) new Notice(`Literal prefixes were not saved. ${errors[0]}`)
      return
    }
    settings.queryLiteralPrefixes = next
    await saveSettings(plugin)
  }

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
