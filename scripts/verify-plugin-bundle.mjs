import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(projectRoot, 'dist')
const requiredFiles = ['main.js', 'manifest.json', 'styles.css']

function fail(message) {
  console.error(`Plugin bundle verification failed: ${message}`)
  process.exit(1)
}

for (const filename of requiredFiles) {
  const fullPath = path.join(outputDir, filename)
  if (!existsSync(fullPath)) {
    fail(`missing ${fullPath}. Run pnpm build, then copy the contents of dist into .obsidian/plugins/banana/.`)
  }
  if (statSync(fullPath).size === 0) fail(`${filename} is empty`)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
} catch (error) {
  fail(`dist manifest.json is invalid JSON (${String(error)})`)
}

if (manifest.id !== 'banana') {
  fail(`manifest id is ${JSON.stringify(manifest.id)}, expected "banana"`)
}
const packageInfo = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
if (manifest.name !== 'Banana') fail(`manifest name is ${JSON.stringify(manifest.name)}, expected "Banana"`)
if (manifest.version !== packageInfo.version) fail(`manifest version ${manifest.version} does not match package version ${packageInfo.version}`)
if (manifest.version !== '1.0.0') fail(`release manifest version is ${manifest.version}, expected 1.0.0 for this release`)
if (manifest.author !== 'Neomoorea' || manifest.authorUrl !== 'https://github.com/Neomoorea') {
  fail('manifest author and authorUrl must be Neomoorea and https://github.com/Neomoorea')
}

const apiSource = readFileSync(path.join(projectRoot, 'src', 'tools', 'api.ts'), 'utf8')
if (!apiSource.includes('publishPluginApi(plugin, api)')) {
  fail('API registration does not publish on the active Banana plugin instance')
}
if (typeof manifest.minAppVersion !== 'string' || !manifest.minAppVersion) {
  fail('manifest is missing minAppVersion')
}

const mainJs = readFileSync(path.join(outputDir, 'main.js'), 'utf8')
if (!mainJs.includes('Banana startup failed')) {
  fail('main.js does not contain the startup diagnostics marker. Rebuild from the updated source; this may be a stale bundle.')
}


console.log('Plugin bundle verification passed:')
for (const filename of requiredFiles) {
  console.log(`  ${filename}: ${statSync(path.join(outputDir, filename)).size.toLocaleString()} bytes`)
}
console.log(`  plugin id: ${manifest.id}`)
console.log(`  minimum Obsidian version: ${manifest.minAppVersion}`)
console.log('Install the three files directly in <vault>/.obsidian/plugins/banana/.')
