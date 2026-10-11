import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'

const manifests = { win32: 'latest.yml', darwin: 'latest-mac.yml', linux: 'latest-linux.yml' }

/** Verify the exact files that will be uploaded, including their full byte hashes. */
export async function verifyReleaseAssets(directory, platform, version) {
  const platforms = platform === 'all' ? Object.keys(manifests) : [platform]
  const names = new Set(await readdir(directory))
  const checked = []
  for (const target of platforms) {
    const manifest = manifests[target]
    if (!manifest) throw new Error(`Unknown platform: ${target}`)
    const info = load(await readFile(join(directory, manifest), 'utf8'))
    if (info?.version !== version) throw new Error(`${manifest}: expected version ${version}`)
    if (!Array.isArray(info.files) || info.files.length === 0) throw new Error(`${manifest}: missing files`)
    const urls = info.files.map((file) => file.url)
    const has = (extension, arm64) => urls.some((url) => typeof url === 'string' && url.endsWith(extension) &&
      (arm64 === undefined || url.includes('arm64') === arm64))
    if (target === 'win32' && !has('.exe')) throw new Error(`${manifest}: missing NSIS exe`)
    if (target === 'linux' && !has('.AppImage')) throw new Error(`${manifest}: missing AppImage`)
    if (target === 'darwin') {
      for (const arm64 of [false, true]) {
        for (const extension of ['.dmg', '.zip']) {
          if (!has(extension, arm64)) throw new Error(`${manifest}: missing ${arm64 ? 'arm64' : 'x64'} ${extension}`)
        }
      }
    }
    const legacy = info.files.find((file) => file.url === info.path)
    if (!legacy || legacy.sha512 !== info.sha512) throw new Error(`${manifest}: inconsistent path/sha512`)
    for (const file of info.files) {
      // Spaces become dots with action-gh-release; require upload-stable names.
      if (typeof file.url !== 'string' || !/^[A-Za-z0-9._-]+$/.test(file.url)) {
        throw new Error(`${manifest}: unsafe asset name ${file.url}`)
      }
      if (!names.has(file.url)) throw new Error(`${manifest}: missing asset ${file.url}`)
      const path = join(directory, file.url)
      const size = (await stat(path)).size
      if (size !== file.size) throw new Error(`${file.url}: size mismatch`)
      const hash = createHash('sha512')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      if (hash.digest('base64') !== file.sha512) throw new Error(`${file.url}: SHA-512 mismatch`)
      if (target === 'win32' && file.url.endsWith('.exe') && !names.has(`${file.url}.blockmap`)) {
        throw new Error(`${file.url}: missing blockmap`)
      }
      checked.push({ manifest, file: file.url, size })
    }
  }
  return checked
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = JSON.parse(await readFile('package.json', 'utf8')).version
  const checked = await verifyReleaseAssets(process.argv[2] ?? 'release', process.argv[3] ?? process.platform, version)
  console.log(JSON.stringify({ version, checked }, null, 2))
}
