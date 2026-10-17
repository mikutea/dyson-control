import type { Mod } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'
import { buildStoredZip } from './zip.js'

function versionParts(version: string): { major: number; minor: number; patch: number } {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (!match) throw new GameAdapterError('MOD_VERSION_UNSUPPORTED', `Mod version is not compatible with r2modman: ${version}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function createR2ModmanPackage(profileName: string, address: string, mods: Mod[]): Buffer {
  if (!address || address.length > 255 || /[\s\0]/u.test(address)) throw new GameAdapterError('INVALID_INPUT', 'The game connection address must be one nonempty line without whitespace.')
  const unconfirmed = mods.filter(mod => mod.enabled && mod.side === 'unknown')
  if (unconfirmed.length) throw new GameAdapterError('MOD_SIDE_UNCONFIRMED', `请先在模组页面确认这些版本的适用端：${unconfirmed.map(mod => mod.name).join('、')}`)
  const importable = mods.filter((mod) => mod.enabled && mod.side !== 'server')
  if (importable.length === 0) throw new GameAdapterError('NO_CLIENT_MODS', 'No enabled client-compatible mods were found.')
  for (const mod of importable) {
    if (!/^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/.test(mod.name)) {
      throw new GameAdapterError('MOD_PACKAGE_UNIDENTIFIED', `The Thunderstore identity for ${mod.name} is unknown. Record its owner and package name before exporting.`)
    }
  }
  const profile = {
    profileName,
    mods: importable.map((mod) => ({ name: mod.name, version: versionParts(mod.version), enabled: true }))
  }
  const config = `[Nebula - Settings]\nNickname =\nServerPassword =\nLastClientPassword =\nHostPort = 8469\nEnableUPnpOrPmpSupport = false\nEnableNgrok = false\nNgrokAuthtoken =\nRememberLastIP = true\nRememberLastClientPassword = false\nLastIP = ${address}\nRemoteAccessEnabled = false\nRemoteAccessPassword =\n`
  return buildStoredZip([
    { name: 'export.r2x', data: `${JSON.stringify(profile, null, 2)}\n` },
    { name: 'config/nebula.cfg', data: config }
  ])
}
