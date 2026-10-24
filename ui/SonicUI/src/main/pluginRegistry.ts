import { createPublicKey } from 'node:crypto'
import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  nameWithPlugin,
  resolvePluginHost,
  type SonicPluginManifest,
  type SonicPluginPermission,
  type PluginReview,
  type PluginSummary
} from '../shared/pluginApi'
import { verifyPluginManifest } from './pluginTrust'

type PluginRecord = {
  manifest: SonicPluginManifest
  enabled: boolean
  grantedPermissions: SonicPluginPermission[]
  previousManifest?: SonicPluginManifest
}
type RegistryState = {
  version: 1
  trustedKeys: Record<string, string>
  plugins: PluginRecord[]
}
const emptyState = (): RegistryState => ({ version: 1, trustedKeys: {}, plugins: [] })
const keyIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/

function parseJson(input: string): unknown {
  if (typeof input !== 'string' || input.length > 1024 * 1024) {
    throw new Error('Plugin manifest must be JSON text no larger than 1 MB.')
  }
  try {
    return JSON.parse(input)
  } catch {
    throw new Error('Plugin manifest is not valid JSON.')
  }
}

function validateEd25519Key(keyId: string, pem: string): void {
  if (!keyIdPattern.test(keyId)) throw new Error('Signer key ID must be a lowercase identifier.')
  if (typeof pem !== 'string' || pem.length > 16_384)
    throw new Error('Public key PEM is invalid or too large.')
  let key
  try {
    key = createPublicKey(pem)
  } catch {
    throw new Error('Public key PEM could not be parsed.')
  }
  if (key.asymmetricKeyType !== 'ed25519')
    throw new Error('Only Ed25519 public keys are supported.')
}

export class PluginRegistry {
  private state = emptyState()
  private readonly directory = join(app.getPath('userData'), 'plugins')
  private readonly filePath = join(this.directory, 'registry.json')
  private readonly ready = this.load()

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<RegistryState>
      if (parsed.version !== 1 || !parsed.trustedKeys || !Array.isArray(parsed.plugins)) {
        throw new Error('Plugin registry schema is invalid.')
      }
      const trustedKeys: Record<string, string> = {}
      for (const [keyId, pem] of Object.entries(parsed.trustedKeys)) {
        try {
          validateEd25519Key(keyId, pem)
          trustedKeys[keyId] = pem
        } catch {
          // Invalid persisted keys fail closed and are omitted from trust.
        }
      }
      const plugins: PluginRecord[] = []
      for (const raw of parsed.plugins) {
        if (!raw || typeof raw !== 'object' || !('manifest' in raw)) continue
        const record = raw as PluginRecord
        const verified = verifyPluginManifest(record.manifest, trustedKeys, app.getVersion())
        if (!verified.valid || !verified.manifest) continue
        const declared = verified.manifest.permissions
        const granted = Array.isArray(record.grantedPermissions)
          ? record.grantedPermissions.filter((permission) => declared.includes(permission))
          : []
        plugins.push({
          manifest: verified.manifest,
          enabled:
            record.enabled === true && declared.every((permission) => granted.includes(permission)),
          grantedPermissions: granted,
          ...(record.previousManifest ? { previousManifest: record.previousManifest } : {})
        })
      }
      this.state = { version: 1, trustedKeys, plugins }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(
          '[Sonic plugins] registry could not be loaded; starting with an empty, fail-closed registry.',
          error
        )
      }
      this.state = emptyState()
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const temporary = this.filePath + '.tmp'
    await writeFile(temporary, JSON.stringify(this.state, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    await rename(temporary, this.filePath)
  }

  private summary(record: PluginRecord): PluginSummary {
    return {
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      keyId: record.manifest.signature.keyId,
      permissions: [...record.manifest.permissions],
      grantedPermissions: [...record.grantedPermissions],
      enabled: record.enabled,
      hasRollback: !!record.previousManifest
    }
  }

  async list(): Promise<{ trustedKeyIds: string[]; plugins: PluginSummary[] }> {
    await this.ready
    return {
      trustedKeyIds: Object.keys(this.state.trustedKeys).sort(),
      plugins: this.state.plugins.map((record) => this.summary(record))
    }
  }

  async trustKey(keyId: string, publicKeyPem: string): Promise<void> {
    await this.ready
    validateEd25519Key(keyId, publicKeyPem)
    const existing = this.state.trustedKeys[keyId]
    if (existing && existing !== publicKeyPem) {
      throw new Error('That key ID already has a different key. Use a new key ID for rotation.')
    }
    this.state.trustedKeys[keyId] = publicKeyPem
    await this.persist()
  }

  async revokeKey(keyId: string): Promise<void> {
    await this.ready
    if (!this.state.trustedKeys[keyId]) throw new Error('Trusted signer key was not found.')
    delete this.state.trustedKeys[keyId]
    for (const record of this.state.plugins) {
      if (record.manifest.signature.keyId === keyId) {
        record.enabled = false
        record.grantedPermissions = []
      }
    }
    await this.persist()
  }

  async review(input: string): Promise<PluginReview> {
    await this.ready
    const validation = verifyPluginManifest(
      parseJson(input),
      this.state.trustedKeys,
      app.getVersion()
    )
    if (!validation.valid || !validation.manifest)
      return { valid: false, errors: validation.errors }
    const manifest = validation.manifest
    return {
      valid: true,
      errors: [],
      summary: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        keyId: manifest.signature.keyId,
        permissions: [...manifest.permissions]
      }
    }
  }

  async install(input: string): Promise<PluginSummary> {
    await this.ready
    const validation = verifyPluginManifest(
      parseJson(input),
      this.state.trustedKeys,
      app.getVersion()
    )
    if (!validation.valid || !validation.manifest) {
      throw new Error(validation.errors.join(' ') || 'Plugin manifest verification failed.')
    }
    const manifest = validation.manifest
    const existingIndex = this.state.plugins.findIndex(
      (record) => record.manifest.id === manifest.id
    )
    const previous = existingIndex >= 0 ? this.state.plugins[existingIndex] : undefined
    const record: PluginRecord = {
      manifest,
      enabled: false,
      grantedPermissions: [],
      ...(previous ? { previousManifest: previous.manifest } : {})
    }
    if (existingIndex >= 0) this.state.plugins.splice(existingIndex, 1, record)
    else this.state.plugins.push(record)
    await this.persist()
    return this.summary(record)
  }

  async setPermissions(
    pluginId: string,
    permissions: SonicPluginPermission[]
  ): Promise<PluginSummary> {
    await this.ready
    const record = this.state.plugins.find((entry) => entry.manifest.id === pluginId)
    if (!record) throw new Error('Installed plugin was not found.')
    if (
      !Array.isArray(permissions) ||
      permissions.some((permission) => !record.manifest.permissions.includes(permission))
    ) {
      throw new Error('Permission grants must be a subset of the manifest permissions.')
    }
    record.grantedPermissions = [...new Set(permissions)]
    if (
      !record.manifest.permissions.every((permission) =>
        record.grantedPermissions.includes(permission)
      )
    ) {
      record.enabled = false
    }
    await this.persist()
    return this.summary(record)
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginSummary> {
    await this.ready
    const record = this.state.plugins.find((entry) => entry.manifest.id === pluginId)
    if (!record) throw new Error('Installed plugin was not found.')
    if (
      enabled &&
      !record.manifest.permissions.every((permission) =>
        record.grantedPermissions.includes(permission)
      )
    ) {
      throw new Error('Grant every requested permission before enabling this declarative plugin.')
    }
    record.enabled = enabled
    await this.persist()
    return this.summary(record)
  }

  async uninstall(pluginId: string): Promise<void> {
    await this.ready
    this.state.plugins = this.state.plugins.filter((entry) => entry.manifest.id !== pluginId)
    await this.persist()
  }

  async rollback(pluginId: string): Promise<PluginSummary> {
    await this.ready
    const record = this.state.plugins.find((entry) => entry.manifest.id === pluginId)
    if (!record?.previousManifest)
      throw new Error('No previous plugin version is available to roll back to.')
    const previous = record.previousManifest
    if (!verifyPluginManifest(previous, this.state.trustedKeys, app.getVersion()).valid) {
      throw new Error('The previous plugin version is no longer trusted; rollback was refused.')
    }
    record.manifest = previous
    delete record.previousManifest
    record.enabled = false
    record.grantedPermissions = []
    await this.persist()
    return this.summary(record)
  }

  async resolveUrl(url: string): Promise<string | null> {
    await this.ready
    for (const record of this.state.plugins) {
      if (!record.enabled) continue
      const grantedManifest = {
        ...record.manifest,
        permissions: record.manifest.permissions.filter((permission) =>
          record.grantedPermissions.includes(permission)
        )
      }
      const resolved = resolvePluginHost(grantedManifest, url)
      if (resolved) return resolved
    }
    return null
  }

  async nameFile(url: string, currentName: string): Promise<string | null> {
    await this.ready
    for (const record of this.state.plugins) {
      if (!record.enabled) continue
      const grantedManifest = {
        ...record.manifest,
        permissions: record.manifest.permissions.filter((permission) =>
          record.grantedPermissions.includes(permission)
        )
      }
      const name = nameWithPlugin(grantedManifest, url, currentName)
      if (name) return name
    }
    return null
  }
}
