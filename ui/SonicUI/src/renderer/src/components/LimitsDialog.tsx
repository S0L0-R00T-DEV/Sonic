import { DEFAULT_DOWNLOAD_SCHEDULE, validSchedule } from '@shared/downloadSchedule'
import { DOWNLOADS_AT_ONCE, type AppSettings, type DownloadSchedule } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { describeError } from '../utils/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Alert, AlertDescription } from './ui/alert'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Minus, Plus } from 'lucide-react'
import { ScheduleFields } from './ScheduleFields'
import { PluginManagement } from './PluginManagement'
import { RemoteControlSettings } from './RemoteControlSettings'
import { PerformanceDiagnostics } from './PerformanceDiagnostics'
import { useLocale } from '../i18n'

type Draft = Pick<
  ReturnType<typeof useAppStore.getState>,
  'downloadsAtOnce' | 'downloadSchedule' | 'completionAction'
>

const DEFAULTS = {
  downloadsAtOnce: DOWNLOADS_AT_ONCE.default,
  downloadSchedule: undefined,
  completionAction: 'notify'
} satisfies Partial<Draft>

export function LimitsDialog({
  showSchedule = false,
  open,
  onOpenChange
}: {
  showSchedule?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  page: string | null
  onPageChange: (page: string | null) => void
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        initialFocus={
          showSchedule
            ? () => {
                contentRef.current
                  ?.querySelector<HTMLElement>('[aria-label="Download schedule"]')
                  ?.scrollIntoView({ block: 'start' })
                return (
                  contentRef.current?.querySelector<HTMLElement>(
                    '[aria-label="Enable download schedule"]'
                  ) ?? false
                )
              }
            : undefined
        }
        showCloseButton={false}
        className="flex h-[min(520px,calc(100%-2rem))] max-w-[560px] flex-col gap-0 p-0 sm:max-w-[560px]"
      >
        {open && <SettingsEditor onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function SettingsEditor({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { locale, setLocale, t } = useLocale()
  const [draft, setDraft] = useState<Draft>(() => {
    const { downloadsAtOnce, downloadSchedule, completionAction } = useAppStore.getState()
    return { downloadsAtOnce, downloadSchedule, completionAction }
  })
  const [confirmReset, setConfirmReset] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storageInfo, setStorageInfo] = useState<{ userDataDir: string; portable: boolean } | null>(
    null
  )
  const [storageBusy, setStorageBusy] = useState(false)
  const [storageMessage, setStorageMessage] = useState<string | null>(null)
  const [expectedSha256, setExpectedSha256] = useState('')
  const [integrityBusy, setIntegrityBusy] = useState(false)
  const [integrityMessage, setIntegrityMessage] = useState<string | null>(null)
  const [updateRepository, setUpdateRepository] = useState(
    () => useAppStore.getState().updateRepository ?? ''
  )
  const [publisherPublicKeyPem, setPublisherPublicKeyPem] = useState(
    () => useAppStore.getState().publisherPublicKeyPem ?? ''
  )
  const [publisherKeyFingerprint, setPublisherKeyFingerprint] = useState(
    () => useAppStore.getState().publisherKeyFingerprint ?? ''
  )
  const [expectedPublisherFingerprint, setExpectedPublisherFingerprint] = useState(
    () => useAppStore.getState().publisherKeyFingerprint ?? ''
  )
  const [signedManifestJson, setSignedManifestJson] = useState('')
  const [publisherBusy, setPublisherBusy] = useState(false)
  const [publisherTrustMessage, setPublisherTrustMessage] = useState<string | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateResult, setUpdateResult] = useState<Awaited<
    ReturnType<typeof window.sonic.checkForUpdate>
  > | null>(null)
  const [updateDownloadBusy, setUpdateDownloadBusy] = useState(false)
  const [verifiedUpdate, setVerifiedUpdate] = useState<{
    operationId: string
    fileName: string
    sha256: string
  } | null>(null)
  const [updateActionMessage, setUpdateActionMessage] = useState<string | null>(null)
  useEffect(() => {
    void window.sonic
      .getStorageInfo()
      .then(setStorageInfo)
      .catch((cause: unknown) => {
        setStorageMessage(describeError(cause))
      })
  }, [])
  const valid = draft.downloadSchedule === undefined || validSchedule(draft.downloadSchedule)
  const atDefaults =
    draft.downloadsAtOnce === DEFAULTS.downloadsAtOnce &&
    draft.downloadSchedule === DEFAULTS.downloadSchedule &&
    draft.completionAction === DEFAULTS.completionAction

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const current = useAppStore.getState()
    const patch: AppSettings = {}
    if (draft.downloadsAtOnce !== current.downloadsAtOnce)
      patch.downloadsAtOnce = draft.downloadsAtOnce
    if (draft.completionAction !== current.completionAction)
      patch.completionAction = draft.completionAction
    if (draft.downloadSchedule !== current.downloadSchedule)
      patch.downloadSchedule = draft.downloadSchedule
    try {
      await window.sonic.updateSettings(patch)
      useAppStore.setState(patch)
      onClose()
    } catch (cause) {
      setError(describeError(cause))
      setSaving(false)
    }
  }

  const resetDraft = (): void => {
    setDraft({ ...DEFAULTS })
    setConfirmReset(false)
  }

  const runStorageAction = async (action: 'export' | 'restore' | 'portable'): Promise<void> => {
    setStorageBusy(true)
    setStorageMessage(null)
    try {
      if (action === 'export') {
        const saved = await window.sonic.exportStorageBackup()
        setStorageMessage(saved ? 'Backup exported.' : 'Backup export cancelled.')
      } else if (action === 'restore') {
        const restored = await window.sonic.restoreStorageBackup()
        if (restored)
          setStorageMessage(
            'Backup validated and restored. Sonic is restarting to load saved tasks.'
          )
      } else {
        const destination = await window.sonic.configurePortableStorage()
        if (destination) setStorageMessage('Portable storage configured. Sonic is restarting.')
      }
    } catch (cause) {
      setStorageMessage(describeError(cause))
    } finally {
      setStorageBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-center border-b-[0.5px] border-border px-4 py-3">
        <DialogTitle className="text-[16px] font-semibold">{t('settings')}</DialogTitle>
      </div>
      <fieldset disabled={saving} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section
          aria-labelledby="language-setting-title"
          className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3"
        >
          <h3
            id="language-setting-title"
            className="font-sans text-[14px] leading-none font-semibold"
          >
            {t('language')}
          </h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            {t('languageDescription')}
          </p>
          <label htmlFor="sonic-language" className="text-sm">
            {t('language')}
          </label>
          <select
            id="sonic-language"
            value={locale}
            onChange={(event) => setLocale(event.target.value === 'ur' ? 'ur' : 'en')}
            className="min-h-10 rounded-md border border-input bg-background px-3 text-foreground"
          >
            <option value="en">{t('english')}</option>
            <option value="ur">{t('urdu')}</option>
          </select>
        </section>
        <section
          aria-labelledby="accessibility-setting-title"
          className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3"
        >
          <h3
            id="accessibility-setting-title"
            className="font-sans text-[14px] leading-none font-semibold"
          >
            {t('accessibility')}
          </h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            {t('accessibilityDescription')}
          </p>
        </section>
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">
            {t('downloadsAtOnce')}
          </h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Other downloads wait in the queue and start automatically.
          </p>
          <div className="flex items-center gap-3 text-[13.5px]">
            <div className="flex items-center rounded-lg border border-input">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Decrease simultaneous downloads"
                disabled={draft.downloadsAtOnce <= DOWNLOADS_AT_ONCE.min}
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    downloadsAtOnce: previous.downloadsAtOnce - 1
                  }))
                }
              >
                <Minus />
              </Button>
              <output
                aria-label="Downloads at once"
                className="w-8 text-center font-mono tabular-nums"
              >
                {draft.downloadsAtOnce}
              </output>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Increase simultaneous downloads"
                disabled={draft.downloadsAtOnce >= DOWNLOADS_AT_ONCE.max}
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    downloadsAtOnce: previous.downloadsAtOnce + 1
                  }))
                }
              >
                <Plus />
              </Button>
            </div>
            at the same time
          </div>
        </section>
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">
            When a download finishes
          </h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Choose whether Sonic should notify you or open the completed file. Opening is opt-in.
          </p>
          <select
            aria-label="Completion action"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={draft.completionAction}
            onChange={(event) =>
              setDraft((previous) => ({
                ...previous,
                completionAction: event.currentTarget.value as 'none' | 'notify' | 'open'
              }))
            }
          >
            <option value="none">No action</option>
            <option value="notify">Show a notification</option>
            <option value="open">Open the completed file</option>
          </select>
        </section>
        <ScheduleFields
          schedule={draft.downloadSchedule ?? DEFAULT_DOWNLOAD_SCHEDULE}
          onChange={(downloadSchedule: DownloadSchedule) =>
            setDraft((previous) => ({ ...previous, downloadSchedule }))
          }
        />
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">Software updates</h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Check the latest stable public GitHub release. Enter Sonic&apos;s official
            publisher/repository as owner/repository. This check does not silently install or
            restart the app.
          </p>
          <label htmlFor="sonic-update-repository" className="text-sm">
            Official GitHub repository
          </label>
          <input
            id="sonic-update-repository"
            value={updateRepository}
            onChange={(event) => setUpdateRepository(event.currentTarget.value)}
            placeholder="owner/repository"
            autoComplete="off"
            spellCheck={false}
            className="min-h-10 rounded-md border border-input bg-background px-3 font-mono text-xs text-foreground"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={updateBusy || !updateRepository.trim()}
            onClick={() => {
              setUpdateBusy(true)
              setUpdateResult(null)
              void window.sonic
                .updateSettings({ updateRepository: updateRepository.trim() })
                .then(() => useAppStore.setState({ updateRepository: updateRepository.trim() }))
                .then(() => window.sonic.checkForUpdate(updateRepository))
                .then(setUpdateResult)
                .catch((cause: unknown) =>
                  setUpdateResult({
                    configured: true,
                    currentVersion: 'unknown',
                    error: describeError(cause)
                  })
                )
                .finally(() => setUpdateBusy(false))
            }}
          >
            {updateBusy ? 'Checking?' : 'Check for updates'}
          </Button>
          {updateResult && (
            <div role="status" className="break-words text-xs text-muted-foreground">
              {updateResult.error
                ? updateResult.error
                : updateResult.updateAvailable
                  ? 'Update available: ' + updateResult.latestVersion
                  : 'Sonic is up to date (installed ' +
                    updateResult.currentVersion +
                    ', latest ' +
                    updateResult.latestVersion +
                    ').'}
              {updateResult.releaseNotes && (
                <p className="mt-2 whitespace-pre-wrap">{updateResult.releaseNotes}</p>
              )}
              {updateResult.releaseUrl && (
                <p className="mt-2">
                  <a
                    className="underline"
                    href={updateResult.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open release page and notes
                  </a>
                </p>
              )}
              {updateResult.verificationError && (
                <p className="mt-2">{updateResult.verificationError}</p>
              )}
              {updateResult.assetName && updateResult.assetSha256 && (
                <div className="mt-2 space-y-2">
                  <p>
                    Publisher signature verified for {updateResult.assetName}. Signed SHA-256:{' '}
                    <span className="break-all font-mono">{updateResult.assetSha256}</span>
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={updateDownloadBusy}
                    onClick={() => {
                      setUpdateDownloadBusy(true)
                      setUpdateActionMessage(null)
                      setVerifiedUpdate(null)
                      void window.sonic
                        .downloadVerifiedUpdate(updateRepository.trim())
                        .then((result) => {
                          setVerifiedUpdate(result)
                          setUpdateActionMessage(
                            'Installer downloaded and SHA-256 verified: ' +
                              result.fileName +
                              '. Hash: ' +
                              result.sha256
                          )
                        })
                        .catch((cause: unknown) =>
                          setUpdateActionMessage('Update download blocked: ' + describeError(cause))
                        )
                        .finally(() => setUpdateDownloadBusy(false))
                    }}
                  >
                    {updateDownloadBusy
                      ? 'Downloading and verifying?'
                      : 'Download and verify installer'}
                  </Button>
                </div>
              )}
              {verifiedUpdate && (
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  onClick={() => {
                    setUpdateActionMessage('')
                    void window.sonic
                      .openVerifiedUpdate(verifiedUpdate.operationId)
                      .then((result) =>
                        setUpdateActionMessage(
                          result.opened
                            ? 'Verified installer opened. Follow the installer prompts; close Sonic first if requested.'
                            : 'Installer could not be opened: ' + (result.error ?? 'unknown error')
                        )
                      )
                      .catch((cause: unknown) =>
                        setUpdateActionMessage('Installer launch blocked: ' + describeError(cause))
                      )
                  }}
                >
                  Open verified installer
                </Button>
              )}
              {updateActionMessage && (
                <p role="status" className="mt-2 break-all">
                  {updateActionMessage}
                </p>
              )}
              {updateResult.updateAvailable && (
                <p className="mt-2">
                  Sonic does not run downloaded code automatically. The installer is opened only
                  after signature and SHA-256 verification and an explicit click. Installer rollback
                  is not provided by this updater.
                </p>
              )}
            </div>
          )}
        </section>
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">
            File integrity verification
          </h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Compare a file against a SHA-256 digest obtained independently from a trusted publisher.
            A match confirms integrity relative to that digest; it does not by itself prove who
            published the file.
          </p>
          <label htmlFor="sonic-expected-sha256" className="text-sm">
            Expected SHA-256
          </label>
          <input
            id="sonic-expected-sha256"
            value={expectedSha256}
            onChange={(event) => setExpectedSha256(event.currentTarget.value)}
            placeholder="64 hexadecimal characters"
            autoComplete="off"
            spellCheck={false}
            className="min-h-10 rounded-md border border-input bg-background px-3 font-mono text-xs text-foreground"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={integrityBusy || !expectedSha256.trim()}
            onClick={() => {
              setIntegrityBusy(true)
              setIntegrityMessage(null)
              void window.sonic
                .verifyFileSha256(expectedSha256)
                .then((result) => {
                  if (result.cancelled) setIntegrityMessage('Verification cancelled.')
                  else
                    setIntegrityMessage(
                      (result.ok ? 'MATCH' : 'MISMATCH') +
                        ' ? ' +
                        result.fileName +
                        '. SHA-256: ' +
                        result.actual +
                        '. ' +
                        (result.ok
                          ? 'Integrity matches; publisher authenticity is not established by this comparison.'
                          : 'Do not use this file unless the mismatch is resolved.')
                    )
                })
                .catch((cause: unknown) => setIntegrityMessage(describeError(cause)))
                .finally(() => setIntegrityBusy(false))
            }}
          >
            {integrityBusy ? 'Verifying?' : 'Choose file and verify'}
          </Button>
          {integrityMessage && (
            <p role="status" className="break-words text-xs text-muted-foreground">
              {integrityMessage}
            </p>
          )}
        </section>
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">
            Trusted publisher verification
          </h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Pin an Ed25519 public key only after obtaining its SHA-256 fingerprint through an
            independent trusted channel. A key copied from the same release page is not an
            independent trust anchor.
          </p>
          <label htmlFor="sonic-publisher-key" className="text-sm">
            Publisher Ed25519 public key (PEM)
          </label>
          <textarea
            id="sonic-publisher-key"
            value={publisherPublicKeyPem}
            onChange={(event) => setPublisherPublicKeyPem(event.currentTarget.value)}
            rows={4}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground"
            placeholder="-----BEGIN PUBLIC KEY-----"
          />
          <label htmlFor="sonic-publisher-fingerprint" className="text-sm">
            Independently verified SHA-256 fingerprint
          </label>
          <input
            id="sonic-publisher-fingerprint"
            value={expectedPublisherFingerprint}
            onChange={(event) => setExpectedPublisherFingerprint(event.currentTarget.value)}
            placeholder="64 hexadecimal characters"
            autoComplete="off"
            spellCheck={false}
            className="min-h-10 rounded-md border border-input bg-background px-3 font-mono text-xs text-foreground"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={
                publisherBusy ||
                !publisherPublicKeyPem.trim() ||
                !expectedPublisherFingerprint.trim()
              }
              onClick={() => {
                setPublisherBusy(true)
                setPublisherTrustMessage(null)
                void window.sonic
                  .fingerprintPublisherKey(publisherPublicKeyPem)
                  .then(async (fingerprint) => {
                    if (fingerprint !== expectedPublisherFingerprint.trim().toLowerCase())
                      throw new Error('Fingerprint mismatch. The key was not pinned.')
                    const patch: AppSettings = {
                      publisherPublicKeyPem,
                      publisherKeyFingerprint: fingerprint
                    }
                    await window.sonic.updateSettings(patch)
                    useAppStore.setState(patch)
                    setPublisherKeyFingerprint(fingerprint)
                    setExpectedPublisherFingerprint(fingerprint)
                    setPublisherTrustMessage('Publisher key pinned. Fingerprint: ' + fingerprint)
                  })
                  .catch((cause: unknown) => setPublisherTrustMessage(describeError(cause)))
                  .finally(() => setPublisherBusy(false))
              }}
            >
              {publisherBusy ? 'Verifying?' : 'Verify fingerprint and pin key'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={publisherBusy || !publisherKeyFingerprint}
              onClick={() => {
                const patch: AppSettings = {
                  publisherPublicKeyPem: undefined,
                  publisherKeyFingerprint: undefined
                }
                void window.sonic
                  .updateSettings(patch)
                  .then(() => {
                    useAppStore.setState(patch)
                    setPublisherPublicKeyPem('')
                    setPublisherKeyFingerprint('')
                    setExpectedPublisherFingerprint('')
                    setPublisherTrustMessage('Pinned publisher key cleared.')
                  })
                  .catch((cause: unknown) => setPublisherTrustMessage(describeError(cause)))
              }}
            >
              Clear pinned key
            </Button>
          </div>
          {publisherKeyFingerprint && (
            <p className="break-all text-xs text-muted-foreground">
              Pinned fingerprint: {publisherKeyFingerprint}
            </p>
          )}
          <label htmlFor="sonic-signed-manifest" className="text-sm">
            Detached signed manifest JSON
          </label>
          <textarea
            id="sonic-signed-manifest"
            value={signedManifestJson}
            onChange={(event) => setSignedManifestJson(event.currentTarget.value)}
            rows={4}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground"
            placeholder="{ payload, signature, keyId }"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={publisherBusy || !publisherKeyFingerprint || !signedManifestJson.trim()}
            onClick={() => {
              setPublisherBusy(true)
              setPublisherTrustMessage(null)
              void window.sonic
                .verifyPublisherManifest(
                  signedManifestJson,
                  publisherPublicKeyPem,
                  publisherKeyFingerprint
                )
                .then((result) =>
                  setPublisherTrustMessage(
                    'VALID SIGNATURE. Pinned publisher fingerprint: ' +
                      result.publicKeyFingerprint +
                      (result.keyId ? '. Key ID: ' + result.keyId : '') +
                      '. Signed payload: ' +
                      result.payload
                  )
                )
                .catch((cause: unknown) =>
                  setPublisherTrustMessage('NOT VERIFIED: ' + describeError(cause))
                )
                .finally(() => setPublisherBusy(false))
            }}
          >
            Verify signed manifest
          </Button>
          {publisherTrustMessage && (
            <p role="status" className="break-all text-xs text-muted-foreground">
              {publisherTrustMessage}
            </p>
          )}
        </section>
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">{t('backupStorage')}</h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Backups include settings, history, queue/torrent metadata, and media manifests, not the
            downloaded file contents. Some saved task metadata may contain encrypted browser-session
            data that only decrypts on this Windows account. Portable mode copies app data to an
            empty, writable folder and restarts Sonic. Removable drives can disconnect; permission
            problems can prevent Sonic from starting or saving, and drive failure can lose data.
            Keep a separate backup and do not use a shared folder you do not trust.
          </p>
          <p className="break-all text-xs text-muted-foreground">
            {storageInfo
              ? (storageInfo.portable ? 'Portable storage: ' : 'Storage: ') +
                storageInfo.userDataDir
              : 'Checking storage locationâ€¦'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={storageBusy}
              onClick={() => void runStorageAction('export')}
            >
              {t('exportBackup')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={storageBusy}
              onClick={() => void runStorageAction('restore')}
            >
              {t('restoreBackup')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={storageBusy || Boolean(storageInfo?.portable)}
              onClick={() => void runStorageAction('portable')}
            >
              Choose portable folder
            </Button>
          </div>
          {storageMessage && (
            <p role="status" className="text-xs text-muted-foreground">
              {storageMessage}
            </p>
          )}
        </section>
        <PerformanceDiagnostics />
        `r`n <RemoteControlSettings />
        <PluginManagement />
        <div className="flex flex-wrap items-center gap-2 border-t-[0.5px] border-border pt-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={atDefaults}
            onClick={() => setConfirmReset(true)}
          >
            Reset to defaults
          </Button>
        </div>
      </fieldset>
      {(!valid || error) && (
        <div className="px-4 pb-2">
          <Alert variant="destructive">
            <AlertDescription>
              {error ?? 'Check schedule times, repeat days and end date.'}
            </AlertDescription>
          </Alert>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-border px-4 py-2">
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button type="button" disabled={!valid || saving} onClick={() => void save()}>
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset settings to defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              This resets downloads at once and disables the download schedule. Other app settings
              are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={resetDraft}>Reset to defaults</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
