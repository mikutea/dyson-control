import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadHealthIdentity, MAINTENANCE_MARKER, MaintenanceGate } from './health.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('health identity', () => {
  it('comes from the release package', async () => {
    const identity = await loadHealthIdentity()
    expect(identity.product).toBe('dyson-control')
    expect(identity.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  })
})

describe('maintenance gate', () => {
  it.each(['', '\uFEFF'])('pauses once for an atomically published token with BOM %j and resumes after removal', async (bom) => {
    const directory = await mkdtemp(join(tmpdir(), 'dyson-control-health-'))
    temporaryDirectories.push(directory)
    const transitions: string[] = []
    const gate = new MaintenanceGate(
      directory,
      () => transitions.push('pause'),
      () => transitions.push('resume'),
    )

    await expect(gate.refresh()).resolves.toEqual({ accepting: true, maintenanceToken: null })

    const token = '0123456789abcdef0123456789abcdef'
    const marker = join(directory, MAINTENANCE_MARKER)
    const partial = `${marker}.partial`
    await writeFile(partial, bom + JSON.stringify({
      schema: 1,
      product: 'dyson-control-maintenance',
      token,
      requestedByProcessId: 1234,
      createdAt: new Date().toISOString(),
    }))
    await rename(partial, marker)

    await expect(gate.refresh()).resolves.toEqual({ accepting: false, maintenanceToken: token })
    await expect(gate.refresh()).resolves.toEqual({ accepting: false, maintenanceToken: token })
    expect(transitions).toEqual(['pause'])

    await rm(marker)
    await expect(gate.refresh()).resolves.toEqual({ accepting: true, maintenanceToken: null })
    expect(transitions).toEqual(['pause', 'resume'])
  })

  it('fails closed for an invalid or unsafe marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dyson-control-health-'))
    temporaryDirectories.push(directory)
    const transitions: string[] = []
    const gate = new MaintenanceGate(
      directory,
      () => transitions.push('pause'),
      () => transitions.push('resume'),
    )
    const marker = join(directory, MAINTENANCE_MARKER)

    await writeFile(marker, '{"schema":1,"token":"not-owned"}')
    await expect(gate.refresh()).resolves.toEqual({ accepting: false, maintenanceToken: null })
    expect(transitions).toEqual(['pause'])
  })
})
