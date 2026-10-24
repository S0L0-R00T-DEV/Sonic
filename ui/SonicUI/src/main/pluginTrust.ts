import { verify as verifySignature } from 'node:crypto'
import type { PluginManifestValidation, SonicPluginManifest } from '../shared/pluginApi'
import {
  isPluginCompatible,
  pluginSigningPayload,
  validatePluginManifest
} from '../shared/pluginApi'

/** Verifies a declarative manifest against an app-maintained trust store. A key embedded in the
 * plugin itself is never trusted. No plugin code is loaded or executed by this verifier. */
export function verifyPluginManifest(
  input: unknown,
  trustedPublicKeys: Readonly<Record<string, string>>,
  appVersion: string
): PluginManifestValidation {
  const validation = validatePluginManifest(input)
  if (!validation.valid || !validation.manifest) return validation
  const manifest = validation.manifest
  if (!isPluginCompatible(manifest, appVersion)) {
    return {
      valid: false,
      errors: [
        `Plugin requires app version ${manifest.minAppVersion} or later; current version is ${appVersion}.`
      ]
    }
  }
  const publicKey = trustedPublicKeys[manifest.signature.keyId]
  if (!publicKey) {
    return {
      valid: false,
      errors: [
        `Signing key ${manifest.signature.keyId} is not in the application's trusted-key registry.`
      ]
    }
  }
  try {
    const { signature: omittedSignature, ...unsigned } = manifest
    void omittedSignature
    const signature = Buffer.from(manifest.signature.value, 'base64')
    if (
      signature.length !== 64 ||
      !verifySignature(null, Buffer.from(pluginSigningPayload(unsigned)), publicKey, signature)
    ) {
      return { valid: false, errors: ['Plugin signature verification failed.'] }
    }
  } catch {
    return { valid: false, errors: ['Plugin signature or trusted public key is malformed.'] }
  }
  return validation
}

/** Safe hook invocation is data-only; arbitrary JavaScript entry points are not supported. */
export function enabledDeclarativePlugin(
  manifest: SonicPluginManifest,
  granted: ReadonlySet<string>
): boolean {
  return manifest.permissions.every((permission) => granted.has(`${manifest.id}:${permission}`))
}
