import { app, dialog, safeStorage } from 'electron'
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { generate } from 'selfsigned'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NetworkInterfaceInfo } from '../shared/types'
import {
  createRemoteCredential,
  isPrivateLanIPv4,
  isSameLocalIPv4Subnet,
  remoteScopeAllows,
  RemoteRateLimiter,
  verifyRemoteCredential,
  type RemoteDeviceCredential,
  type RemoteScope
} from './remoteControlSecurity'

const PORT = 47831
const CONFIG_FILE = 'remote-control-v1.enc'
const BODY_LIMIT = 16 * 1024
const PAIR_TTL_MS = 3 * 60_000
const TOKEN_TTL_MS = 24 * 60 * 60_000
const ALLOWED_SCOPES: RemoteScope[] = ['status:read', 'task:add', 'task:control']

type RemoteConfig = {
  version: 1
  preferredInterfaceId?: string
  ca?: { privateKey: string; certificate: string; fingerprint: string }
  devices: RemoteDeviceCredential[]
}
type Dispatch = (request: Record<string, unknown>) => Promise<unknown>
type Pairing = { code: string; scopes: RemoteScope[]; expiresAt: number; attempts: number }
type IdempotentResult = { fingerprint: string; expiresAt: number; result: unknown }
type ActiveServer = {
  server: Server
  interfaceId: string
  ip: string
  netmask: string
  caFingerprint: string
}
let config: RemoteConfig | null = null
let dispatch: Dispatch | null = null
let active: ActiveServer | null = null
let pairing: Pairing | null = null
let pairingLimiter = new RemoteRateLimiter(5, 60_000, 256)
const authLimiter = new RemoteRateLimiter(90, 60_000, 512)
const idempotency = new Map<string, IdempotentResult>()
const audit: { at: number; event: string; deviceId?: string }[] = []

function record(event: string, deviceId?: string): void {
  audit.push({ at: Date.now(), event, ...(deviceId ? { deviceId } : {}) })
  if (audit.length > 200) audit.splice(0, audit.length - 200)
}
function secureStorageAvailable(): void {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      'OS-protected credential storage is unavailable; remote control stays disabled.'
    )
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error(
      'Remote control requires a secure OS keyring. Configure a supported Linux keyring before enabling it.'
    )
  }
}
function configPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE)
}
async function loadConfig(): Promise<RemoteConfig> {
  if (config) return config
  secureStorageAvailable()
  try {
    const encrypted = await readFile(configPath(), 'utf8')
    const parsed: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as RemoteConfig).version !== 1 ||
      !Array.isArray((parsed as RemoteConfig).devices)
    ) {
      throw new Error(
        'Saved remote-control credentials are invalid; remote control remains disabled.'
      )
    }
    const candidate = parsed as RemoteConfig
    candidate.devices = candidate.devices.filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.tokenHash === 'string' &&
        /^[a-f0-9]{64}$/i.test(item.tokenHash) &&
        Array.isArray(item.scopes) &&
        item.scopes.every((scope) => ALLOWED_SCOPES.includes(scope)) &&
        typeof item.label === 'string' &&
        typeof item.createdAt === 'number' &&
        typeof item.expiresAt === 'number' &&
        Number.isFinite(item.expiresAt)
    )
    config = candidate
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') config = { version: 1, devices: [] }
    else throw error
  }
  return config
}
async function saveConfig(): Promise<void> {
  if (!config) throw new Error('Remote-control configuration is not loaded.')
  secureStorageAvailable()
  const encrypted = safeStorage.encryptString(JSON.stringify(config)).toString('base64')
  const path = configPath()
  const temporary = path + '.tmp'
  await writeFile(temporary, encrypted, { mode: 0o600 })
  await rename(temporary, path)
}
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}
function testLoopbackAllowed(): boolean {
  return !app.isPackaged && process.env['SONIC_E2E_REMOTE_LOOPBACK'] === '1'
}
function allowedLanAddress(address: string): boolean {
  return privateIpv4(address) || (testLoopbackAllowed() && address === '127.0.0.1')
}
function privateIpv4(address: string): boolean {
  return isPrivateLanIPv4(address)
}
function ipv4Number(address: string): number | null {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return null
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}
function sameSubnet(peer: string, local: string, netmask: string): boolean {
  return isSameLocalIPv4Subnet(peer, local, netmask)
}
function wifiInterfaces(interfaces: NetworkInterfaceInfo[]): NetworkInterfaceInfo[] {
  return interfaces.filter(
    (item) =>
      item.kind === 'wifi' &&
      item.addresses.some(
        (address) =>
          address.family === 4 &&
          allowedLanAddress(address.address) &&
          address.netmask &&
          ipv4Number(address.netmask) !== null
      )
  )
}
function send(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  })
  res.end(body)
}
function html(res: ServerResponse): void {
  const body = MOBILE_CLIENT
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  })
  res.end(body)
}
async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > BODY_LIMIT)
      throw Object.assign(new Error('Request body is too large.'), { status: 413 })
    chunks.push(part)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400 })
  }
  return parsed as Record<string, unknown>
}
function peerIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '')
}
function scopeOf(value: unknown): RemoteScope[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > ALLOWED_SCOPES.length ||
    value.some(
      (scope) => typeof scope !== 'string' || !ALLOWED_SCOPES.includes(scope as RemoteScope)
    )
  ) {
    throw new Error('Choose one or more valid remote permissions.')
  }
  return [...new Set(value as RemoteScope[])]
}
function publicTask(value: unknown): Record<string, unknown> {
  const item = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const id = typeof item.id === 'string' ? item.id.slice(0, 128) : ''
  const status = typeof item.status === 'string' ? item.status.slice(0, 32) : 'unknown'
  const total = Number(item.totalBytes ?? item.total ?? 0)
  const done = Number(item.downloadedBytes ?? item.bytesDownloaded ?? item.bytes ?? 0)
  const progress = Number(item.progressPercent ?? (total > 0 ? (done / total) * 100 : 0))
  return {
    id,
    name: String(item.name ?? item.fileName ?? item.suggestedFileName ?? 'Download').slice(0, 240),
    status,
    kind: typeof item.kind === 'string' ? item.kind : 'download',
    totalBytes: Number.isFinite(total) && total > 0 ? total : 0,
    bytesDownloaded: Number.isFinite(done) && done >= 0 ? done : 0,
    progressPercent: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0,
    speedBytesPerSec: Number.isFinite(Number(item.speedBytesPerSec))
      ? Number(item.speedBytesPerSec)
      : 0
  }
}
function parseBearer(req: IncomingMessage): string | null {
  const value = req.headers.authorization
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return null
  const token = value.slice(7)
  return token.length >= 32 && token.length <= 256 ? token : null
}
function authorized(req: IncomingMessage, required: RemoteScope): RemoteDeviceCredential | null {
  const token = parseBearer(req)
  if (!token || !config) return null
  const hash = createHash('sha256').update(token).digest('hex')
  const credential = config.devices.find((item) => {
    const a = Buffer.from(item.tokenHash, 'hex')
    const b = Buffer.from(hash, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  })
  if (
    !credential ||
    !verifyRemoteCredential(token, credential) ||
    !remoteScopeAllows(credential, required)
  )
    return null
  return credential
}
function originAllowed(req: IncomingMessage, ip: string): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  return origin === `https://${ip}:${PORT}`
}
function idempotentKey(tokenHash: string, key: string): string {
  return tokenHash + ':' + key
}
function clearExpiredIdempotency(now = Date.now()): void {
  for (const [key, value] of idempotency) if (value.expiresAt <= now) idempotency.delete(key)
}
async function idempotent(
  credential: RemoteDeviceCredential,
  key: unknown,
  request: Record<string, unknown>,
  operation: () => Promise<unknown>
): Promise<unknown> {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw Object.assign(new Error('A unique Idempotency-Key header is required.'), { status: 400 })
  }
  clearExpiredIdempotency()
  const mapKey = idempotentKey(credential.tokenHash, key)
  const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  const prior = idempotency.get(mapKey)
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw Object.assign(new Error('Idempotency key was already used for a different request.'), {
        status: 409
      })
    return prior.result
  }
  if (idempotency.size >= 1024)
    throw Object.assign(new Error('Idempotency capacity reached; retry later.'), { status: 503 })
  const expiresAt = Date.now() + TOKEN_TTL_MS
  const pending = operation()
  idempotency.set(mapKey, { fingerprint, expiresAt, result: pending })
  try {
    const result = await pending
    idempotency.set(mapKey, { fingerprint, expiresAt, result })
    return result
  } catch (error) {
    idempotency.delete(mapKey)
    throw error
  }
}
function mobileSafeError(error: unknown): { status: number; message: string } {
  const value = error as { status?: number; message?: string }
  if (Number.isInteger(value?.status) && value.status! >= 400 && value.status! < 500) {
    const message =
      typeof value.message === 'string' ? value.message.slice(0, 240) : 'Request rejected.'
    return { status: value.status!, message }
  }
  return { status: 500, message: 'Remote request failed. Check Sonic on the desktop for details.' }
}

const MOBILE_CLIENT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#111318"><title>Sonic Companion</title>
<style>
:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#111318;color:#f5f5f5}*{box-sizing:border-box}body{margin:0 auto;padding:20px 16px 48px;max-width:720px}h1{font-size:1.55rem;margin:.4rem 0}p{color:#b8beca;line-height:1.5}.panel,article{border:1px solid #363b45;border-radius:14px;padding:16px;margin:14px 0;background:#191c23}label{display:block;font-size:.9rem;margin:12px 0 6px}input{width:100%;min-height:44px;padding:10px;border-radius:8px;border:1px solid #505866;background:#0e1015;color:white;font:inherit}button{min-height:42px;border:0;border-radius:9px;padding:10px 14px;background:#d8e0ff;color:#151a2a;font-weight:650;margin:6px 6px 0 0}button.secondary{background:#303642;color:#f5f5f5}button.danger{background:#632e35;color:white}.row{display:flex;gap:8px;flex-wrap:wrap}.row button{flex:1}.muted{font-size:.85rem;color:#a9b0bd}.hidden{display:none!important}.status{display:inline-block;border:1px solid #4a5260;border-radius:20px;padding:3px 9px;font-size:.78rem}.bar{height:6px;border-radius:8px;background:#333946;overflow:hidden;margin:8px 0}.bar span{display:block;height:100%;background:#a9c0ff}.name{font-weight:650;overflow-wrap:anywhere}.meta{font-size:.85rem;color:#b8beca;margin-top:5px}.notice{color:#ffcf8a;white-space:pre-wrap}.ok{color:#a4e5bd}button:focus-visible,input:focus-visible{outline:3px solid #a9c0ff;outline-offset:2px}
</style></head><body><h1>Speed-o'-Freq Sonic</h1><p>Companion control · same local Wi-Fi only</p>
<section id="pairPanel" class="panel"><h2>Pair this phone</h2><p>Enter the short-lived code shown in Sonic on your computer. Pairing codes expire after three minutes and can be used once.</p><form id="pairForm"><label for="code">Pairing code</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required><label for="device">Phone name</label><input id="device" maxlength="64" autocomplete="nickname" value="My phone" required><button type="submit">Pair phone</button></form></section>
<section id="mainPanel" class="hidden"><div class="panel"><div class="row"><button id="refresh">Refresh status</button><button id="forget" class="secondary">Forget this phone</button></div><p id="message" role="status" aria-live="polite"></p></div>
<div class="panel"><h2>Add a download</h2><form id="addForm"><label for="url">HTTP(S) or magnet link</label><input id="url" type="url" placeholder="https://example.com/file.zip" required><button type="submit">Add download</button></form></div>
<h2>Downloads</h2><div id="downloads"></div></section>
<script>
const $=id=>document.getElementById(id);let token=localStorage.getItem('sonic-companion-token')||'';let busy=false;
async function api(path,options={}){const headers={'Content-Type':'application/json',...(options.headers||{})};if(token)headers.Authorization='Bearer '+token;const response=await fetch(path,{...options,headers,cache:'no-store'});const data=await response.json().catch(()=>({error:'Invalid server response'}));if(!response.ok)throw new Error(data.error||'Request failed ('+response.status+')');return data}
function showMessage(text,good=false){$('message').textContent=text;$('message').className=good?'ok':''}
function showPaired(){ $('pairPanel').classList.toggle('hidden',!!token);$('mainPanel').classList.toggle('hidden',!token);if(token)refresh()}
$('pairForm').addEventListener('submit',async e=>{e.preventDefault();try{const data=await api('/api/pair',{method:'POST',body:JSON.stringify({code:$('code').value.trim(),label:$('device').value.trim()})});token=data.token;localStorage.setItem('sonic-companion-token',token);$('code').value='';showPaired();showMessage('Phone paired. Save this browser profile to keep its credential.',true)}catch(err){showMessage(err.message)}});
function bytes(n){if(!Number.isFinite(n)||n<=0)return '0 B';const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1000&&i<u.length-1){n/=1000;i++}return n.toFixed(i?1:0)+' '+u[i]}
function esc(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function refresh(){if(!token)return;try{const data=await api('/api/status');$('downloads').innerHTML='';for(const item of data.downloads){const card=document.createElement('article');const p=Math.max(0,Math.min(100,Number(item.progressPercent)||0));card.innerHTML='<div class="name">'+esc(item.name)+'</div><div class="meta"><span class="status">'+esc(item.status)+'</span> · '+bytes(item.bytesDownloaded)+' / '+(item.totalBytes?bytes(item.totalBytes):'unknown size')+'</div><div class="bar"><span style="width:'+p+'%"></span></div><div class="meta">'+p.toFixed(1)+'% · '+bytes(item.speedBytesPerSec)+'/s</div><div class="row"><button data-action="pause">Pause</button><button data-action="resume" class="secondary">Resume</button><button data-action="cancel" class="danger">Cancel</button></div>';for(const button of card.querySelectorAll('button')){button.addEventListener('click',()=>{if(button.dataset.action==='cancel'&&!confirm('Cancel this download?'))return;act(item.id,button.dataset.action,button)})} $('downloads').append(card)}if(!data.downloads.length)$('downloads').innerHTML='<article>No downloads yet.</article>';showMessage('Connected to Sonic.',true)}catch(err){showMessage(err.message);if(/credential|authoriz|revok/i.test(err.message)){token='';localStorage.removeItem('sonic-companion-token');showPaired()}}}
async function act(id,action,button){if(busy)return;busy=true;button.disabled=true;try{await api('/api/tasks/'+encodeURIComponent(id)+'/action',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({action})});await refresh()}catch(err){showMessage(err.message)}finally{busy=false;button.disabled=false}}
$('addForm').addEventListener('submit',async e=>{e.preventDefault();try{const url=$('url').value.trim();await api('/api/tasks',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({url})});$('url').value='';showMessage('Download added.',true);await refresh()}catch(err){showMessage(err.message)}});
$('refresh').addEventListener('click',refresh);$('forget').addEventListener('click',()=>{token='';localStorage.removeItem('sonic-companion-token');showPaired()});showPaired();
</script></body></html>`

export function configureRemoteControl(dispatcher: Dispatch): void {
  dispatch = dispatcher
}

export async function loadRemoteControlState(
  interfaces: NetworkInterfaceInfo[]
): Promise<ReturnType<typeof getRemoteControlState>> {
  await loadConfig()
  return getRemoteControlState(interfaces)
}

export function getRemoteControlState(interfaces: NetworkInterfaceInfo[]): {
  enabled: boolean
  url: string | null
  interfaceId: string | null
  caFingerprint: string | null
  pairingExpiresAt: number | null
  auditEvents: { at: number; event: string; deviceId?: string }[]
  devices: {
    id: string
    label: string
    scopes: RemoteScope[]
    createdAt: number
    expiresAt: number
    revoked: boolean
  }[]
  wifiInterfaces: { id: string; displayName: string; addresses: string[] }[]
} {
  const available = wifiInterfaces(interfaces)
  return {
    enabled: Boolean(active),
    url: active ? `https://${active.ip}:${PORT}/` : null,
    interfaceId: active?.interfaceId ?? null,
    caFingerprint: active?.caFingerprint ?? config?.ca?.fingerprint ?? null,
    pairingExpiresAt: pairing?.expiresAt ?? null,
    auditEvents: audit.slice(-10).reverse(),
    devices: (config?.devices ?? []).map(
      ({ id, label, scopes, createdAt, expiresAt, revokedAt }) => ({
        id,
        label,
        scopes,
        createdAt,
        expiresAt,
        revoked: revokedAt !== undefined || expiresAt <= Date.now()
      })
    ),
    wifiInterfaces: available.map((item) => ({
      id: item.id,
      displayName: item.displayName,
      addresses: item.addresses
        .filter((address) => address.family === 4 && allowedLanAddress(address.address))
        .map((address) => address.address)
    }))
  }
}

export async function enableRemoteControl(
  interfaceId: string,
  interfaces: NetworkInterfaceInfo[]
): Promise<ReturnType<typeof getRemoteControlState>> {
  if (active)
    throw new Error(
      'Remote control is already enabled. Disable it before changing Wi-Fi interfaces.'
    )
  if (!dispatch) throw new Error('Remote-control command dispatcher is not ready.')
  const iface = wifiInterfaces(interfaces).find((item) => item.id === interfaceId)
  if (!iface)
    throw new Error(
      'Select an active Wi-Fi interface with a private IPv4 address. Ethernet, USB, bridge and public addresses are not allowed.'
    )
  const address = iface.addresses.find(
    (item) =>
      item.family === 4 &&
      allowedLanAddress(item.address) &&
      item.netmask &&
      ipv4Number(item.netmask) !== null
  )
  if (!address?.netmask) throw new Error('Selected Wi-Fi has no usable IPv4 subnet mask.')
  secureStorageAvailable()
  const current = await loadConfig()
  if (!current.ca) {
    const ca = await generate(
      [{ name: 'commonName', value: "Speed-o'-Freq Sonic Local Wi-Fi CA" }],
      {
        keyType: 'ec',
        curve: 'P-256',
        algorithm: 'sha256',
        notAfterDate: new Date(Date.now() + 5 * 365 * 24 * 60 * 60_000),
        extensions: [
          { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
          { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
        ]
      }
    )
    current.ca = {
      privateKey: ca.private,
      certificate: ca.cert,
      fingerprint: createHash('sha256')
        .update(
          Buffer.from(
            ca.cert.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, ''),
            'base64'
          )
        )
        .digest('hex')
        .toUpperCase()
        .match(/.{2}/g)!
        .join(':')
    }
  }
  const leaf = await generate([{ name: 'commonName', value: address.address }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    ca: { key: current.ca.privateKey, cert: current.ca.certificate },
    notAfterDate: new Date(Date.now() + 180 * 24 * 60 * 60_000),
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: address.address }] }
    ]
  })
  current.preferredInterfaceId = interfaceId
  config = current
  await saveConfig()
  pairing = null
  pairingLimiter = new RemoteRateLimiter(5, 60_000, 256)
  const server = createServer(
    { key: leaf.private, cert: leaf.cert, minVersion: 'TLSv1.2' },
    (req, res) => {
      void (async () => {
        if (!active) return send(res, 503, { error: 'Remote control is disabled.' })
        const peer = peerIp(req)
        if (req.headers.host !== `${address.address}:${PORT}`) {
          record('host-denied')
          return send(res, 400, { error: 'Invalid local server address.' })
        }
        if (!sameSubnet(peer, address.address, address.netmask!)) {
          record('network-denied')
          return send(res, 403, { error: 'This device is not on the selected local Wi-Fi subnet.' })
        }
        if (!authLimiter.allow(peer))
          return send(res, 429, { error: 'Too many requests. Wait before trying again.' })
        if (!originAllowed(req, address.address))
          return send(res, 403, { error: 'Cross-origin requests are not allowed.' })
        if (req.method === 'GET' && req.url === '/') return html(res)
        if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true })
        const path = new URL(req.url ?? '/', `https://${address.address}:${PORT}`).pathname
        if (req.method === 'POST' && path === '/api/pair') {
          if (!pairing || pairing.expiresAt <= Date.now()) {
            pairing = null
            return send(res, 410, {
              error: 'Pairing code expired. Generate a new code on the desktop.'
            })
          }
          if (!pairingLimiter.allow(peer) || pairing.attempts >= 5)
            return send(res, 429, {
              error: 'Too many pairing attempts. Generate a new code on the desktop.'
            })
          const body = await bodyJson(req)
          pairing.attempts++
          const supplied = typeof body.code === 'string' ? body.code : ''
          const a = Buffer.from(pairing.code)
          const b = Buffer.from(supplied)
          if (a.length !== b.length || !timingSafeEqual(a, b)) {
            record('pair-failed')
            return send(res, 401, { error: 'Pairing code is incorrect.' })
          }
          const label = typeof body.label === 'string' ? body.label.trim().slice(0, 64) : ''
          if (!label || hasControlCharacters(label))
            return send(res, 400, { error: 'Enter a valid phone name.' })
          const issued = createRemoteCredential(label, pairing.scopes)
          config!.devices.push(issued.credential)
          await saveConfig()
          pairing = null
          record('device-paired', issued.credential.id)
          return send(res, 201, {
            token: issued.token,
            deviceId: issued.credential.id,
            scopes: issued.credential.scopes
          })
        }
        if (req.method === 'GET' && path === '/api/status') {
          const credential = authorized(req, 'status:read')
          if (!credential) return send(res, 401, { error: 'Not authorized for status:read.' })
          const result = await dispatch!({ command: 'list' })
          const items = Array.isArray(result) ? result : []
          record('status-read', credential.id)
          return send(res, 200, {
            application: "Speed-o'-Freq Sonic",
            downloads: items.map(publicTask).filter((item) => item.id)
          })
        }
        const taskMatch = path.match(/^\/api\/tasks\/([^/]+)\/action$/)
        if (req.method === 'POST' && path === '/api/tasks') {
          const credential = authorized(req, 'task:add')
          if (!credential) return send(res, 401, { error: 'Not authorized for task:add.' })
          const body = await bodyJson(req)
          const url = typeof body.url === 'string' ? body.url.trim() : ''
          if (!url || url.length > 8192)
            return send(res, 400, { error: 'Enter a valid download URL.' })
          let parsed: URL
          try {
            parsed = new URL(url)
          } catch {
            return send(res, 400, {
              error: 'Only HTTP(S) and magnet links can be added from the companion.'
            })
          }
          if (
            !['http:', 'https:', 'magnet:'].includes(parsed.protocol) ||
            (parsed.protocol !== 'magnet:' && (parsed.username || parsed.password)) ||
            hasControlCharacters(url)
          ) {
            return send(res, 400, {
              error: 'Only credential-free HTTP(S) and magnet links are allowed.'
            })
          }
          const result = await idempotent(
            credential,
            req.headers['idempotency-key'],
            { action: 'add', url },
            () => dispatch!({ command: 'add', url })
          )
          record('task-added', credential.id)
          return send(res, 202, { result: publicTask(result) })
        }
        if (req.method === 'POST' && taskMatch) {
          const credential = authorized(req, 'task:control')
          if (!credential) return send(res, 401, { error: 'Not authorized for task:control.' })
          const id = decodeURIComponent(taskMatch[1])
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
            return send(res, 400, { error: 'Invalid task ID.' })
          const body = await bodyJson(req)
          const action = body.action
          if (!['pause', 'resume', 'cancel'].includes(String(action)))
            return send(res, 400, { error: 'Action must be pause, resume or cancel.' })
          const result = await idempotent(
            credential,
            req.headers['idempotency-key'],
            { action, id },
            () => dispatch!({ command: action, id })
          )
          record('task-control-' + action, credential.id)
          return send(res, 200, { result: publicTask(result) })
        }
        return send(res, 404, { error: 'Endpoint not found.' })
      })().catch((error: unknown) => {
        const safe = mobileSafeError(error)
        record('request-error')
        if (!res.headersSent) send(res, safe.status, { error: safe.message })
        else res.destroy()
      })
    }
  )
  server.maxConnections = 16
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.keepAliveTimeout = 5_000
  server.on('error', () => record('server-error'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, address.address, () => resolve())
  })
  active = {
    server,
    interfaceId,
    ip: address.address,
    netmask: address.netmask!,
    caFingerprint: current.ca!.fingerprint
  }
  record('server-enabled')
  return getRemoteControlState(interfaces)
}

export async function disableRemoteControl(): Promise<void> {
  pairing = null
  if (!active) return
  const current = active
  active = null
  await new Promise<void>((resolve) => current.server.close(() => resolve()))
  record('server-disabled')
}

export async function preferredRemoteInterfaceId(): Promise<string | null> {
  const current = await loadConfig()
  return current.preferredInterfaceId ?? null
}

export async function createRemotePairingCode(
  scopes: RemoteScope[]
): Promise<{ code: string; expiresAt: number }> {
  if (!active) throw new Error('Enable remote control on a local Wi-Fi interface first.')
  const normalized = scopeOf(scopes)
  pairing = {
    code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
    scopes: normalized,
    expiresAt: Date.now() + PAIR_TTL_MS,
    attempts: 0
  }
  record('pairing-created')
  return { code: pairing.code, expiresAt: pairing.expiresAt }
}

export async function revokeRemoteDevice(
  id: string
): Promise<ReturnType<typeof getRemoteControlState>['devices']> {
  const current = await loadConfig()
  const credential = current.devices.find((item) => item.id === id)
  if (!credential) throw new Error('Paired device was not found.')
  credential.revokedAt = Date.now()
  pairing = null
  await saveConfig()
  record('device-revoked', id)
  return getRemoteControlState([]).devices
}

export async function exportRemoteCaCertificate(): Promise<boolean> {
  const current = await loadConfig()
  if (!current.ca)
    throw new Error('Enable remote control once to create the local Wi-Fi certificate.')
  const result = await dialog.showSaveDialog({
    title: 'Export Sonic local Wi-Fi CA certificate',
    defaultPath: join(app.getPath('downloads'), 'Sonic-Local-WiFi-CA.crt'),
    buttonLabel: 'Export certificate',
    filters: [{ name: 'X.509 certificate', extensions: ['crt', 'pem'] }]
  })
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, current.ca.certificate, { encoding: 'utf8', flag: 'wx' }).catch(
    async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await writeFile(result.filePath!, current.ca!.certificate, 'utf8')
    }
  )
  return true
}

export function stopRemoteControl(): void {
  pairing = null
  if (!active) return
  const current = active
  active = null
  current.server.close()
}
