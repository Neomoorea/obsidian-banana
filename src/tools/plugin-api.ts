/** Minimal shape needed to publish this fork's public API on its plugin object. */
type ApiOwner = { api?: unknown }
type PluginApiHost = {
  app: unknown
  manifest: { id: string }
}

/**
 * Publish the public API on the active plugin instance and, when Obsidian has
 * already registered it, on the corresponding plugin-manager entry.
 *
 * The registry key is always read from the plugin's manifest, so the API is
 * published only to this plugin's own entry and never to another plugin.
 */
export function publishPluginApi(plugin: PluginApiHost, api: unknown): void {
  // The current instance is always available even during early onload timing.
  Object.assign(plugin, { api })

  const app = plugin.app as {
    plugins?: { plugins?: Record<string, ApiOwner | undefined> }
  } | null
  const registeredPlugin = app?.plugins?.plugins?.[plugin.manifest.id]
  if (registeredPlugin) {
    registeredPlugin.api = api
  }
}
