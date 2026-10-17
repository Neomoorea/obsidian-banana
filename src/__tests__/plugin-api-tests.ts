import { describe, expect, it } from 'vitest'
import { publishPluginApi } from '../tools/plugin-api'

describe('publishPluginApi', () => {
  it('publishes the API on the current plugin when the registry entry is absent', () => {
    const plugin = { app: {}, manifest: { id: 'banana' } }
    const api = { search: () => [] }

    publishPluginApi(plugin, api)

    expect((plugin as typeof plugin & { api?: unknown }).api).toBe(api)
  })

  it('publishes only to the matching manifest ID, not another plugin entry', () => {
    const queryPlugin = {}
    const upstreamPlugin = {}
    const plugin = {
      app: {
        plugins: {
          plugins: {
            'custom-banana-id': queryPlugin,
            banana: upstreamPlugin,
          },
        },
      },
      manifest: { id: 'custom-banana-id' },
    }
    const api = { search: () => [] }

    publishPluginApi(plugin, api)

    expect(queryPlugin).toEqual({ api })
    expect(upstreamPlugin).toEqual({})
    expect((plugin as typeof plugin & { api?: unknown }).api).toBe(api)
  })
})
