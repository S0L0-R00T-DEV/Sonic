import type { DestinationRule } from '@shared/types'
import { FolderOpen, Plus, Tags, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'

export function DownloadOrganizationDialog({
  open,
  onOpenChange,
  selectedIds
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedIds: string[]
}): React.JSX.Element | null {
  const customTags = useAppStore((s) => s.customTags)
  const downloadTags = useAppStore((s) => s.downloadTags)
  const destinationRules = useAppStore((s) => s.destinationRules)
  const setDownloadTags = useAppStore((s) => s.setDownloadTags)
  const [tagText, setTagText] = useState(() => customTags.join(', '))
  const [rules, setRules] = useState<DestinationRule[]>(() =>
    destinationRules.map((rule) => ({ ...rule }))
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (!open) return null
  const tags = [
    ...new Set(
      tagText
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  ].slice(0, 100)
  const assigned = new Set(selectedIds.flatMap((id) => downloadTags[id] ?? []))
  const toggleTag = (tag: string, checked: boolean): void => {
    const next = { ...downloadTags }
    for (const id of selectedIds) {
      const values = new Set(next[id] ?? [])
      if (checked) values.add(tag)
      else values.delete(tag)
      if (values.size) next[id] = [...values]
      else delete next[id]
    }
    setDownloadTags(next)
  }
  const addRule = (): void =>
    setRules((old) => [
      ...old,
      {
        id: crypto.randomUUID(),
        match: 'extension',
        pattern: '.pdf',
        destinationDir: '',
        enabled: true
      }
    ])
  const updateRule = (id: string, patch: Partial<DestinationRule>): void =>
    setRules((old) => old.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)))
  const chooseFolder = async (rule: DestinationRule): Promise<void> => {
    const chosen = await window.sonic.chooseDestinationFolder(
      rule.destinationDir || window.sonic.initialState.downloadsDir
    )
    if (chosen) updateRule(rule.id, { destinationDir: chosen })
  }
  const save = async (): Promise<void> => {
    setError('')
    const cleanedTags = tags.map((tag) => tag.slice(0, 32))
    for (const rule of rules) {
      if (!rule.pattern.trim()) {
        setError('Every enabled rule needs a match value.')
        return
      }
      if (rule.enabled && !rule.destinationDir.trim()) {
        setError('Choose a destination folder for every enabled rule.')
        return
      }
      if (rule.match === 'extension' && !/^\.?[a-z0-9][a-z0-9._+-]*$/i.test(rule.pattern.trim())) {
        setError(`Invalid file extension: ${rule.pattern}`)
        return
      }
      if (
        rule.match === 'domain' &&
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
          rule.pattern.trim()
        )
      ) {
        setError(`Invalid domain: ${rule.pattern}`)
        return
      }
    }
    setBusy(true)
    try {
      const retained = new Set(cleanedTags)
      const cleanedAssignments: Record<string, string[]> = {}
      for (const [id, values] of Object.entries(downloadTags)) {
        const keep = values.filter((tag) => retained.has(tag))
        if (keep.length) cleanedAssignments[id] = keep
      }
      // Persist a single coherent patch; settings-changed refreshes the shared store.
      const cleanedRules = rules.map((rule) => ({
        ...rule,
        pattern: rule.pattern.trim().toLowerCase()
      }))
      await window.sonic.updateSettings({
        customTags: cleanedTags,
        downloadTags: cleanedAssignments,
        destinationRules: cleanedRules
      })
      useAppStore.setState({
        customTags: cleanedTags,
        downloadTags: cleanedAssignments,
        destinationRules: cleanedRules
      })
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onOpenChange(false)
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false)
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="organization-title"
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <Tags className="size-5 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="organization-title" className="font-semibold">
              Tags & automatic destinations
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Organize downloads and route matching files into folders.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            autoFocus
            aria-label="Close organization settings"
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </header>
        <div className="min-h-0 space-y-6 overflow-y-auto p-5">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Custom tags</h3>
            <label className="block text-xs text-muted-foreground" htmlFor="custom-download-tags">
              Comma-separated tag names (up to 32 characters each)
            </label>
            <input
              id="custom-download-tags"
              className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              placeholder="Work, Games, Documents, Media"
            />
            {selectedIds.length > 0 ? (
              <div className="space-y-2 pt-2">
                <p className="text-xs text-muted-foreground">
                  Apply tags to {selectedIds.length} selected download(s):
                </p>
                <div className="flex flex-wrap gap-2">
                  {tags.map((tag) => (
                    <label
                      key={tag}
                      className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={assigned.has(tag)}
                        onChange={(e) => toggleTag(tag, e.target.checked)}
                      />
                      {tag}
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Select downloads in the list first to assign tags. Existing tags remain saved.
              </p>
            )}
          </section>
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">Automatic destination rules</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Rules are checked in order. The first enabled match wins; a folder explicitly
                  chosen for a download takes priority.
                </p>
              </div>
              <Button type="button" size="sm" variant="secondary" onClick={addRule}>
                <Plus data-icon="inline-start" />
                Add rule
              </Button>
            </div>
            {rules.length === 0 && (
              <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                No rules yet. Add one for an extension such as .pdf or a domain such as example.com.
              </p>
            )}
            {rules.map((rule, index) => (
              <div key={rule.id} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <span className="w-5 text-xs text-muted-foreground">{index + 1}.</span>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
                    />
                    Enabled
                  </label>
                  <select
                    aria-label={`Rule ${index + 1} match type`}
                    className="h-8 rounded-md border border-border bg-card px-2 text-xs"
                    value={rule.match}
                    onChange={(e) =>
                      updateRule(rule.id, { match: e.target.value as DestinationRule['match'] })
                    }
                  >
                    <option value="extension">File extension</option>
                    <option value="domain">Source domain</option>
                  </select>
                  <input
                    aria-label={`Rule ${index + 1} match value`}
                    className="h-8 min-w-0 flex-1 rounded-md border border-border bg-card px-2 text-xs"
                    value={rule.pattern}
                    onChange={(e) => updateRule(rule.id, { pattern: e.target.value })}
                    placeholder={rule.match === 'extension' ? '.pdf' : 'example.com'}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove rule ${index + 1}`}
                    onClick={() => setRules((old) => old.filter((item) => item.id !== rule.id))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <div className="flex items-center gap-2 pl-7">
                  <input
                    aria-label={`Rule ${index + 1} destination folder`}
                    className="h-8 min-w-0 flex-1 rounded-md border border-border bg-card px-2 font-mono text-xs"
                    value={rule.destinationDir}
                    onChange={(e) => updateRule(rule.id, { destinationDir: e.target.value })}
                    placeholder="C:\\Users\\You\\Downloads\\Documents"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void chooseFolder(rule)}
                  >
                    <FolderOpen data-icon="inline-start" />
                    Browse
                  </Button>
                </div>
              </div>
            ))}
          </section>
          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving?' : 'Save organization settings'}
          </Button>
        </footer>
      </section>
    </div>
  )
}
