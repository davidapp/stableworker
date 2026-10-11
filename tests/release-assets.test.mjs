import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { dump } from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyReleaseAssets } from '../scripts/verify-release-assets.mjs'

let directory
const version = '0.9.0'
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sw-assets-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function manifest(name, names) {
  const files = []
  for (const url of names) {
    const bytes = Buffer.from(`payload:${url}`)
    await writeFile(join(directory, url), bytes)
    if (url.endsWith('.exe')) await writeFile(join(directory, `${url}.blockmap`), 'blockmap')
    files.push({ url, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') })
  }
  const info = { version, files, path: files[0].url, sha512: files[0].sha512 }
  await writeFile(join(directory, name), dump(info))
  return info
}

describe('release assets', () => {
  it('accepts a complete three-platform release', async () => {
    await manifest('latest.yml', ['StableWorker-Setup-0.9.0-x64.exe'])
    await manifest('latest-linux.yml', ['StableWorker-0.9.0.AppImage'])
    await manifest('latest-mac.yml', ['StableWorker-0.9.0-x64.dmg', 'StableWorker-0.9.0-x64.zip', 'StableWorker-0.9.0-arm64.dmg', 'StableWorker-0.9.0-arm64.zip'])
    expect(await verifyReleaseAssets(directory, 'all', version)).toHaveLength(6)
  })
  it('rejects the v0.9.0 Windows upload rename regression', async () => {
    const info = await manifest('latest.yml', ['StableWorker.Setup.0.9.0.exe'])
    info.path = info.files[0].url = 'StableWorker-Setup-0.9.0.exe'
    await writeFile(join(directory, 'latest.yml'), dump(info))
    await expect(verifyReleaseAssets(directory, 'win32', version)).rejects.toThrow('missing asset')
  })
  it('rejects DMG-only and missing ARM64 ZIP releases', async () => {
    await manifest('latest-mac.yml', ['StableWorker-0.9.0-x64.dmg', 'StableWorker-0.9.0-arm64.dmg'])
    await expect(verifyReleaseAssets(directory, 'darwin', version)).rejects.toThrow('missing x64 .zip')
    await manifest('latest-mac.yml', ['StableWorker-0.9.0-x64.dmg', 'StableWorker-0.9.0-x64.zip', 'StableWorker-0.9.0-arm64.dmg'])
    await expect(verifyReleaseAssets(directory, 'darwin', version)).rejects.toThrow('missing arm64 .zip')
  })
  it('rejects corrupted content even when the size matches', async () => {
    await manifest('latest-linux.yml', ['StableWorker.AppImage'])
    const file = join(directory, 'StableWorker.AppImage')
    const content = await readFile(file)
    content[0] ^= 1
    await writeFile(file, content)
    await expect(verifyReleaseAssets(directory, 'linux', version)).rejects.toThrow('SHA-512 mismatch')
  })
  it('rejects wrong size, version, and legacy metadata', async () => {
    const info = await manifest('latest.yml', ['StableWorker.exe'])
    await expect(verifyReleaseAssets(directory, 'win32', '0.10.0')).rejects.toThrow('expected version')
    info.files[0].size++
    await writeFile(join(directory, 'latest.yml'), dump(info))
    await expect(verifyReleaseAssets(directory, 'win32', version)).rejects.toThrow('size mismatch')
    info.path = 'missing.exe'
    await writeFile(join(directory, 'latest.yml'), dump(info))
    await expect(verifyReleaseAssets(directory, 'win32', version)).rejects.toThrow('inconsistent path/sha512')
  })
  it('rejects missing NSIS blockmaps and names changed by upload', async () => {
    await manifest('latest.yml', ['StableWorker.exe'])
    await rm(join(directory, 'StableWorker.exe.blockmap'))
    await expect(verifyReleaseAssets(directory, 'win32', version)).rejects.toThrow('missing blockmap')
    await manifest('latest.yml', ['StableWorker Setup.exe'])
    await expect(verifyReleaseAssets(directory, 'win32', version)).rejects.toThrow('unsafe asset name')
  })
})
