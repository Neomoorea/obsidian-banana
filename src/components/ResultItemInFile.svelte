<script lang="ts">
  import type { ResultNote } from '../globals'
  import ResultItemContainer from './ResultItemContainer.svelte'
  import type BananaPlugin from '../main'

  export let plugin: BananaPlugin
  export let offset: number
  export let note: ResultNote
  export let index = 0
  export let selected = false

  $: cleanedContent = plugin.textProcessor.makeExcerpt(note?.content ?? '', offset)
</script>

<ResultItemContainer
  id="{index.toString()}"
  on:auxclick
  on:click
  on:longpress
  on:mousemove
  selected="{selected}">
  <div class="banana-result__body">
    {@html plugin.textProcessor.highlightText(cleanedContent, note.matches)}
  </div>
</ResultItemContainer>
