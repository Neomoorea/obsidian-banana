import { readFileSync, writeFileSync } from 'node:fs'

const targetVersion = process.env.npm_package_version
if (!targetVersion) throw new Error('npm_package_version is not set; run this script through the package manager version lifecycle.')

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'))
const minAppVersion = manifest.minAppVersion
for (const filename of ['manifest.json', 'manifest-beta.json']) {
  const current = JSON.parse(readFileSync(filename, 'utf8'))
  current.version = targetVersion
  writeFileSync(filename, `${JSON.stringify(current, null, 2)}\n`)
}

const versions = JSON.parse(readFileSync('versions.json', 'utf8'))
versions[targetVersion] = minAppVersion
writeFileSync('versions.json', `${JSON.stringify(versions, null, 2)}\n`)
console.log(`Updated Banana manifests and compatibility map to ${targetVersion}`)
