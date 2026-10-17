<script lang="ts">
  import { debounce, getAllTags, Platform } from 'obsidian'
  import { createEventDispatcher, onDestroy, tick } from 'svelte'
  import { toggleInputComposition } from '../globals'
  import type BananaPlugin from '../main'
  import { wait } from '../tools/utils'
  import { FIELD_REGISTRY } from '../search/query-language'

  export let initialValue = ''
  export let placeholder = ''
  export let plugin: BananaPlugin
  export let resultCount: number | null = null
  let initialSet = false
  let value = ''
  let elInput: HTMLInputElement
  let completionSuffix = ''
  let ghostStyle = ''
  let ghostContainerStyle = ''
  let completionTimer: number | undefined
  let completionRequestId = 0
  let cachedMetadata: { tags: string[]; properties: string[]; values: Map<string, string[]>; extensions: string[] } | null = null
  const dispatch = createEventDispatcher()

  export function setInputValue(v: string): void {
    value = v
    void refreshCompletion()
  }

  function watchInitialValue(v: string): void {
    if (v && !initialSet && !value) {
      initialSet = true
      value = v
      selectInput()
      void refreshCompletion()
    }
  }

  $: watchInitialValue(initialValue)

  function selectInput(_?: HTMLElement): void {
    tick()
      .then(async () => {
        if (Platform.isMobileApp) await wait(200)
        elInput.focus()
        return tick()
      })
      .then(async () => {
        if (Platform.isMobileApp) await wait(200)
        elInput.select()
      })
  }

  const debouncedHistoryReset = debounce(() => {
    // If typing a query and not executing it, the next time we open the modal,
    // the search field will be empty. This bookkeeping is debounced separately
    // from input dispatch so invalid queries clear stale result rows immediately.
    plugin.searchHistory.addToHistory('')
  }, 300)

  function onInput(): void {
    dispatch('input', value)
    debouncedHistoryReset()
    void refreshCompletion()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (completionSuffix && elInput.selectionStart === value.length && elInput.selectionEnd === value.length) {
        const suffix = completionSuffix
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        completionRequestId++
        completionSuffix = ''
        value += suffix
        dispatch('input', value)
        debouncedHistoryReset()
        void tick().then(() => {
          elInput.setSelectionRange(value.length, value.length)
          syncGhostScroll()
        })
        return
      }
      // Tab belongs to the search field even when there is no completion. Some
      // Obsidian/workspace handlers run in capture phase, so prevent the default,
      // stop this event as early as possible, and restore focus defensively.
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      window.setTimeout(() => {
        if (elInput?.isConnected) elInput.focus({ preventScroll: true })
      }, 0)
      return
    }
    dispatch('keydown', event)

    // Modifier shortcuts must not clear/recreate ghost text. That caused a
    // visible baseline jump while pressing Cmd/Ctrl/Shift. Still refresh if a
    // modified arrow/home/end key actually moves the caret away from the end.
    const caretKeys = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']
    if (['Meta', 'Control', 'Shift', 'Alt', 'Tab'].includes(event.key)) return
    if (event.metaKey || event.ctrlKey || event.altKey) {
      if (caretKeys.includes(event.key)) window.setTimeout(() => void refreshCompletion(true), 0)
      return
    }
    if (!caretKeys.includes(event.key)) return
    window.setTimeout(() => void refreshCompletion(true), 0)
  }

  function syncGhostScroll(): void {
    if (!elInput) return
    const styles = window.getComputedStyle(elInput)
    const parsedFontSize = Number.parseFloat(styles.fontSize)
    const pixels = (value: string): number => Number.parseFloat(value) || 0
    const lineHeight = styles.lineHeight === 'normal'
      ? `${(Number.isFinite(parsedFontSize) ? parsedFontSize : 14) * 1.2}px`
      : styles.lineHeight
    // The ghost overlay spans the input's outer border box. Match the input's
    // content box before centering the ghost line; horizontal inset belongs on
    // the text span so scrolling follows the native input's text origin.
    ghostContainerStyle = [
      `padding-top:${pixels(styles.paddingTop) + pixels(styles.borderTopWidth)}px`,
      `padding-bottom:${pixels(styles.paddingBottom) + pixels(styles.borderBottomWidth)}px`,
      'box-sizing:border-box',
    ].join(';')
    ghostStyle = [
      `padding-left:${pixels(styles.paddingLeft) + pixels(styles.borderLeftWidth)}px`,
      `padding-right:${pixels(styles.paddingRight) + pixels(styles.borderRightWidth)}px`,
      `font:${styles.font}`,
      `font-family:${styles.fontFamily}`,
      `font-size:${styles.fontSize}`,
      `font-weight:${styles.fontWeight}`,
      `letter-spacing:${styles.letterSpacing}`,
      `line-height:${lineHeight}`,
      'box-sizing:border-box',
      `transform:translateX(-${elInput.scrollLeft}px)`,
    ].join(';')
  }

  function getMetadataCompletions(): NonNullable<typeof cachedMetadata> {
    if (cachedMetadata) return cachedMetadata
    const tags = new Set<string>()
    const properties = new Set<string>()
    const values = new Map<string, Set<string>>()
    const extensions = new Set<string>()

    // Obsidian's metadata cache is already populated while the vault is open;
    // this reads cached frontmatter only and never opens note files from disk.
    for (const file of plugin.app.vault.getMarkdownFiles()) {
      extensions.add(file.extension.toLocaleLowerCase())
      const fileCache = plugin.app.metadataCache.getFileCache(file)
      for (const tag of (fileCache ? getAllTags(fileCache) : null) ?? []) {
        tags.add(tag.startsWith('#') ? tag : `#${tag}`)
      }
      const frontmatter = fileCache?.frontmatter
      if (!frontmatter) continue
      for (const [key, rawValue] of Object.entries(frontmatter)) {
        if (key === 'position') continue
        properties.add(key)
        const items = Array.isArray(rawValue) ? rawValue : [rawValue]
        const bucket = values.get(key) ?? new Set<string>()
        for (const item of items) {
          if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
            bucket.add(String(item))
          }
        }
        values.set(key, bucket)
      }
    }
    cachedMetadata = {
      tags: [...tags].sort((a, b) => a.localeCompare(b)),
      properties: [...properties].sort((a, b) => a.localeCompare(b)),
      values: new Map([...values.entries()].map(([key, set]) => [key, [...set].sort((a, b) => a.localeCompare(b))])),
      extensions: [...extensions].sort((a, b) => a.localeCompare(b)),
    }
    return cachedMetadata
  }

  function completionForKnownSyntax(input: string): string | undefined {
    const metadata = getMetadataCompletionsIfNeeded(input)
    const aliases = Object.keys(plugin.settings.queryFieldAliases ?? {})
    const fields = [...new Set([...Object.keys(FIELD_REGISTRY), ...aliases])]
      .sort((a, b) => a.length - b.length || a.localeCompare(b))

    // Complete a partial field name at the end of the input, including after a
    // Boolean operator or opening parenthesis.
    const fieldMatch = /(^|[\s(])([a-z][a-z0-9_-]*)$/iu.exec(input)
    if (fieldMatch) {
      const token = fieldMatch[2]
      const found = fields.find(field => field.toLocaleLowerCase().startsWith(token.toLocaleLowerCase()) && field.toLocaleLowerCase() !== token.toLocaleLowerCase())
      if (found) return `${input.slice(0, input.length - token.length)}${found}:`
    }

    // Complete property keys before their comparator.
    const propertyKey = /^(.*\bproperty:)([^:=\s]*)$/iu.exec(input)
    if (propertyKey && metadata) {
      const token = propertyKey[2]
      const found = metadata.properties.find(property => property.toLocaleLowerCase().startsWith(token.toLocaleLowerCase()) && property.toLocaleLowerCase() !== token.toLocaleLowerCase())
      if (found) return `${propertyKey[1]}${found}`
    }

    // Complete known frontmatter values while a property comparison is being typed.
    const propertyValue = /^(.*\bproperty:)([^:=\s]+)(!=|>=|<=|~=|=|>|<)([^\s]*)$/iu.exec(input)
    if (propertyValue && metadata) {
      const [, prefix, key, operator, token] = propertyValue
      const matchingKey = [...metadata.values.keys()].find(name => name.toLocaleLowerCase() === key.toLocaleLowerCase())
      const candidates = metadata.values.get(key) ?? (matchingKey ? metadata.values.get(matchingKey) : undefined) ?? []
      const found = candidates.find(candidate => candidate.toLocaleLowerCase().startsWith(token.toLocaleLowerCase()) && candidate.toLocaleLowerCase() !== token.toLocaleLowerCase() && !/\s/u.test(candidate))
      if (found) return `${prefix}${key}${operator}${found}`
    }

    // Bare tag patterns are also valid query syntax, so complete them without
    // requiring the explicit `tag:` field prefix.
    if (metadata) {
      const bareTag = /(^|\s)(#[^\s]*)$/u.exec(input)
      if (bareTag) {
        const token = bareTag[2]
        const found = metadata.tags.find(tag => tag.toLocaleLowerCase().startsWith(token.toLocaleLowerCase()) && tag.toLocaleLowerCase() !== token.toLocaleLowerCase())
        if (found) return `${input.slice(0, input.length - token.length)}${found}`
      }
    }

    // Enumerated fields get context-specific values rather than arbitrary words.
    const enumValues: Record<string, string[]> = {
      format: ['markdown', 'pdf', 'office', 'image', 'canvas', 'text', 'other'],
      type: ['note', 'document', 'image', 'canvas', 'other'],
      has: ['tags', 'aliases', 'frontmatter', 'headings', 'tasks', 'links', 'embeds', 'content'],
      is: ['todo', 'done', 'tagged', 'untagged', 'empty', 'orphan', 'note', 'attachment', 'linked', 'unlinked'],
      'task-todo': ['true', 'false'],
      'task-done': ['true', 'false'],
      empty: ['true', 'false'],
      orphan: ['true', 'false'],
    }
    const fieldValue = /^(.*\b([a-z][a-z0-9_-]*):)([^\s]*)$/iu.exec(input)
    if (fieldValue) {
      const [, prefix, rawField, token] = fieldValue
      const field = (plugin.settings.queryFieldAliases?.[rawField] ?? rawField).toLocaleLowerCase()
      let candidates = enumValues[field]
      if (field === 'ext') candidates = metadata?.extensions ?? []
      if (field === 'tag') {
        const tags = metadata?.tags ?? []
        const raw = token.startsWith('#') ? token : `#${token}`
        const found = tags.find(tag => tag.toLocaleLowerCase().startsWith(raw.toLocaleLowerCase()) && tag.toLocaleLowerCase() !== raw.toLocaleLowerCase())
        if (found) return `${prefix}${found}`
      }
      if (candidates) {
        const found = candidates.find(candidate => candidate.toLocaleLowerCase().startsWith(token.toLocaleLowerCase()) && candidate.toLocaleLowerCase() !== token.toLocaleLowerCase())
        if (found) return `${prefix}${found}`
      }
    }
    return undefined
  }

  function getMetadataCompletionsIfNeeded(input: string): NonNullable<typeof cachedMetadata> | null {
    if (/\b(?:property|tag|ext):/iu.test(input) || /(?:^|\s)#[^\s]*$/u.test(input)) return getMetadataCompletions()
    return cachedMetadata
  }

  async function refreshCompletion(preserveWhileComputing = false): Promise<void> {
    const requestId = ++completionRequestId
    if (completionTimer !== undefined) window.clearTimeout(completionTimer)
    if (!elInput || !value || !elInput.isConnected) {
      completionSuffix = ''
      return
    }
    if (elInput.selectionStart !== value.length || elInput.selectionEnd !== value.length) {
      completionSuffix = ''
      return
    }
    if (!preserveWhileComputing) completionSuffix = ''
    syncGhostScroll()

    const typed = value
    completionTimer = window.setTimeout(async () => {
      let fullSuggestion = completionForKnownSyntax(typed)
      if (!fullSuggestion) {
        // For textual fields, predict the value portion without treating the
        // field prefix as part of the MiniSearch suggestion.
        const textFieldValue = /^(.*\b(?:title|file|path|folder|heading|line|task|content|contains|section|block|linksto|linkedby|embed|alias):)([^\s]*)$/iu.exec(typed)
        if (textFieldValue && textFieldValue[2] && !/[()"'\\]/u.test(textFieldValue[2])) {
          const suggestion = plugin.searchEngine.getAutocompleteSuggestion(textFieldValue[2])
          if (suggestion && suggestion.toLocaleLowerCase().startsWith(textFieldValue[2].toLocaleLowerCase())) {
            fullSuggestion = `${textFieldValue[1]}${suggestion}`
          }
        }
      }
      if (!fullSuggestion && !/[:()"'\\]/u.test(typed) && !/\b(?:AND|OR|XOR|XNOR|NAND|NOR|NOT)\s*$/iu.test(typed)) {
        fullSuggestion = plugin.searchEngine.getAutocompleteSuggestion(typed)
      }
      if (requestId !== completionRequestId || typed !== value) return
      if (!fullSuggestion || !fullSuggestion.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase())) {
        if (!preserveWhileComputing) completionSuffix = ''
        return
      }
      const suffix = fullSuggestion.slice(typed.length)
      if (!suffix || !suffix.trim()) {
        if (!preserveWhileComputing) completionSuffix = ''
        return
      }
      completionSuffix = suffix
      syncGhostScroll()
    }, 65)
  }

  function onGhostScroll(): void {
    syncGhostScroll()
  }

  onDestroy(() => {
    if (completionTimer !== undefined) window.clearTimeout(completionTimer)
    completionRequestId++
  })
</script>

<div class="banana-input-container">
  <div class="banana-input-field" class:banana-input-field--with-count={resultCount !== null && resultCount > 0} class:banana-input-field--with-completion={!!completionSuffix}>
    {#if completionSuffix}
      <div class="banana-input-ghost" style={ghostContainerStyle} aria-hidden="true">
        <span class="banana-input-ghost__text" style={ghostStyle}><span class="banana-input-ghost__typed">{value}</span><span class="banana-input-ghost__suffix">{completionSuffix}</span></span>
      </div>
    {/if}
    <input
      bind:this={elInput}
      bind:value
      class="prompt-input"
      class:banana-input--ghosted={!!completionSuffix}
      on:compositionend={_ => toggleInputComposition(false)}
      on:compositionstart={_ => toggleInputComposition(true)}
      on:input={onInput}
      on:keydown={handleKeydown}
      on:scroll={onGhostScroll}
      placeholder={placeholder}
      spellcheck="false"
      type="text"
      use:selectInput />
    {#if resultCount !== null && resultCount > 0}
      <span class="banana-query-result-count" aria-label={`${resultCount} results`}>{resultCount}</span>
    {/if}
  </div>
  <slot />
</div>
