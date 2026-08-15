import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const patchRelative = manifest?.dsh?.bundle?.patch
if (patchRelative !== './cordis.patch.yml') throw new Error('dsh.bundle.patch must point to ./cordis.patch.yml')
if (manifest?.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml') throw new Error('bundle patch export is missing')
if (!Array.isArray(manifest.files) || !manifest.files.includes('cordis.patch.yml')) throw new Error('bundle patch is missing from package files')
const patch = fs.readFileSync(path.join(root, patchRelative), 'utf8')
if (!/^\s*- insert:/m.test(patch)) throw new Error('bundle patch must insert a plugin row')
if (!/^\s+name:\s+dsh-workloads-local-ui1\s*$/m.test(patch)) throw new Error('bundle patch does not mount this package')
if (!/^\s+legacyProcessRoots:\s*\[\]\s*$/m.test(patch)) throw new Error('bundle patch must default legacy migration to opt-in')
console.log(JSON.stringify({ package: manifest.name, version: manifest.version, bundlePatch: patchRelative }))
