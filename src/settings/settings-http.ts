import { Platform, Setting } from 'obsidian'
import type BananaPlugin from '../main'
import type { BananaSettings } from './utils'
import { htmlDescription, saveSettings } from './utils'

export function injectSettingsHttp(
  plugin: BananaPlugin,
  settings: BananaSettings,
  containerEl: HTMLElement
) {
  if (!Platform.isMobile) {
    new Setting(containerEl)
      .setName('API Access Through HTTP')
      .setHeading()
      .setDesc(
        htmlDescription(
          `Banana can be used through a simple HTTP server (<a href="https://github.com/Neomoorea">more information</a>).`
        )
      )

    new Setting(containerEl)
      .setName('Enable the HTTP server')
      .addToggle(toggle =>
        toggle.setValue(settings.httpApiEnabled).onChange(async v => {
          settings.httpApiEnabled = v
          if (v) {
            plugin.apiHttpServer.listen(settings.httpApiPort)
          } else {
            plugin.apiHttpServer.close()
          }
          await saveSettings(plugin)
        })
      )

    new Setting(containerEl).setName('HTTP Port').addText(component => {
      component
        .setValue(settings.httpApiPort)
        .setPlaceholder('51361')
        .onChange(async v => {
          if (parseInt(v) > 65535) {
            v = settings.httpApiPort
            component.setValue(settings.httpApiPort)
          }
          settings.httpApiPort = v
          if (settings.httpApiEnabled) {
            plugin.apiHttpServer.close()
            plugin.apiHttpServer.listen(settings.httpApiPort)
          }
          await saveSettings(plugin)
        })
    })

    new Setting(containerEl)
      .setName('Show a notification when the server starts')
      .setDesc(
        'Will display a notification if the server is enabled, at Obsidian startup.'
      )
      .addToggle(toggle =>
        toggle.setValue(settings.httpApiNotice).onChange(async v => {
          settings.httpApiNotice = v
          await saveSettings(plugin)
        })
      )
  }
}
