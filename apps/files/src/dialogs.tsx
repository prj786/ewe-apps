// The modal cards: conflicts, properties, Open with, Connect to server, credentials,
// batch rename, compress, run a program, archives, extract to, confirmations.

import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import {
  COMPRESS_FORMATS,
  DEFAULT_BATCH_RENAME,
  baseName,
  batchRenameNames,
  fileKind,
  formatBytes,
  isAppImage,
  isFileName,
  modeFromTriplets,
  modeText,
  modeTriplets,
  tildePath,
  type AppEntry,
  type AppInfo,
  type ArchiveListing,
  type BatchRename,
  type CompressFormat,
  type MediaServer,
  type MountAsk,
  type MountQuestion,
  type OpProgress,
  type PathStat,
  type Resolution,
  type SizeProgress,
} from '@ewe/shared'
import { AppRows, Button, Dialog, Field, Icon, OpenWith, Segmented, Switch, toast } from '@ewe/ui'
import { api, errorText, on as onEvent } from './api'

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
export const fmtDate = (ms: number): string => (ms === 0 ? '—' : dateTime.format(new Date(ms)))

// ---- conflicts ------------------------------------------------------------------

export function ConflictDialog(props: {
  op: OpProgress
  onChoose(choice: Resolution, all: boolean): void
}): JSX.Element {
  const [all, setAll] = createSignal(false)
  const c = () => props.op.conflict
  return (
    <Show when={c()}>
      {(conflict) => (
        <Dialog
          open
          title={
            conflict().dir
              ? 'Merge folder “' + baseName(conflict().dest) + '”?'
              : 'Replace “' + baseName(conflict().dest) + '”?'
          }
          description={
            conflict().dir
              ? 'A folder with that name is already there. Merging puts the files into it; you will be asked about files inside that clash.'
              : 'A file with that name is already there.'
          }
          closable={false}
          onClose={() => props.onChoose('cancel', false)}
          actions={
            <>
              <Button kind="ghost" onClick={() => props.onChoose('cancel', false)}>
                Stop
              </Button>
              <Button onClick={() => props.onChoose('skip', all())}>Skip</Button>
              <Button onClick={() => props.onChoose('keep-both', all())}>Keep both</Button>
              <Button kind="primary" onClick={() => props.onChoose('replace', all())}>
                {conflict().dir ? 'Merge' : 'Replace'}
              </Button>
            </>
          }
        >
          <div class="conflict">
            <div class="conflict-side">
              <span class="conflict-head">Already there</span>
              <span class="conflict-name">{baseName(conflict().dest)}</span>
              <span class="conflict-meta">
                {conflict().dir ? 'Folder' : formatBytes(conflict().destSize)} ·{' '}
                {fmtDate(conflict().destMtime)}
              </span>
            </div>
            <Icon name="arrow-right" class="conflict-arrow" />
            <div class="conflict-side">
              <span class="conflict-head">
                {props.op.kind === 'move' ? 'Moving in' : 'Copying in'}
              </span>
              <span class="conflict-name">{baseName(conflict().source)}</span>
              <span class="conflict-meta">
                {conflict().dir ? 'Folder' : formatBytes(conflict().sourceSize)} ·{' '}
                {fmtDate(conflict().sourceMtime)}
              </span>
            </div>
          </div>
          <label class="row-switch">
            <Switch checked={all()} label="Do this for every clash" onChange={setAll} />
            <span>Do this for every clash in this operation</span>
          </label>
        </Dialog>
      )}
    </Show>
  )
}

// ---- properties -----------------------------------------------------------------

function PermissionRow(props: {
  label: string
  value: number
  dir: boolean
  disabled: boolean
  onChange(v: number): void
}): JSX.Element {
  const rw = () => (props.value & 6 ? (props.value & 2 ? '6' : '4') : '0')
  const x = () => (props.value & 1) !== 0
  return (
    <div class="perm-row">
      <span class="perm-label">{props.label}</span>
      <Segmented
        small
        value={rw()}
        label={`${props.label} access`}
        disabled={props.disabled}
        options={[
          { value: '0', label: 'None' },
          { value: '4', label: 'Read' },
          { value: '6', label: 'Read and write' },
        ]}
        onChange={(v) => props.onChange(Number(v) | (x() ? 1 : 0))}
      />
      <label class="perm-x">
        <Switch
          checked={x()}
          label={props.dir ? 'Can open' : 'Can run'}
          disabled={props.disabled}
          onChange={(on) => props.onChange((props.value & 6) | (on ? 1 : 0))}
        />
        <span>{props.dir ? 'Can open' : 'Can run'}</span>
      </label>
    </div>
  )
}

export function PropertiesDialog(props: {
  paths: string[]
  mediaThumb: (path: string) => string
  /** for the apps' own icons */
  server: MediaServer | null
  onClose(): void
}): JSX.Element {
  const first = () => props.paths[0] ?? ''
  const [stat, { refetch }] = createResource(first, (p) => api.stat(p))
  const [mime] = createResource(first, (p) => api.mimeOf(p))
  const [apps] = createResource(
    () => mime()?.type,
    (t) => api.appsFor(t),
  )
  const [size, setSize] = createSignal<SizeProgress | null>(null)
  const [tab, setTab] = createSignal<'about' | 'permissions' | 'open'>('about')
  const [chosenApp, setChosenApp] = createSignal<string | null>(null)
  let sizeId: number | null = null
  const many = () => props.paths.length > 1

  onMount(() => {
    const off = onEvent('size-progress', (p) => {
      if (p.id === sizeId) setSize(p)
    })
    void api.folderSizeStart(props.paths).then((id) => {
      sizeId = id
    })
    onCleanup(() => {
      off()
      if (sizeId !== null) void api.folderSizeStop(sizeId)
    })
  })

  const setMode = (mode: number) => {
    const s = stat()
    if (s === undefined) return
    void api.chmod(s.path, mode).then(
      () => void refetch(),
      (e: unknown) => toast(errorText(e), { kind: 'danger' }),
    )
  }
  const triplets = () => modeTriplets(stat()?.mode ?? 0)
  const setTriplet = (i: 0 | 1 | 2, v: number) => {
    const t = [...triplets()] as [number, number, number]
    t[i] = v
    setMode(modeFromTriplets(t, stat()?.mode ?? 0))
  }
  const defaultApp = () => apps()?.find((a) => a.default) ?? null
  const kind = () => {
    const s = stat()
    return s === undefined ? 'other' : fileKind({ name: s.name, dir: s.dir })
  }
  const sizeText = () => {
    const s = size()
    const st = stat()
    if (st !== undefined && !st.dir && !many()) return formatBytes(st.size)
    if (s === null) return 'Counting…'
    const items = [
      s.files > 0 ? `${s.files} file${s.files === 1 ? '' : 's'}` : '',
      s.dirs > 0 ? `${s.dirs} folder${s.dirs === 1 ? '' : 's'}` : '',
    ]
      .filter((x) => x !== '')
      .join(', ')
    return `${formatBytes(s.bytes)}${items === '' ? '' : ` (${items})`}${s.done ? '' : '…'}`
  }

  return (
    <Dialog
      open
      title={many() ? `${props.paths.length} items` : (stat()?.name ?? baseName(first()))}
      description={many() ? undefined : mime()?.description}
      onClose={() => props.onClose()}
      actions={
        <Button kind="primary" onClick={() => props.onClose()}>
          Done
        </Button>
      }
    >
      <Show when={!many()}>
        <Segmented
          value={tab()}
          label="Section"
          options={[
            { value: 'about', label: 'About' },
            { value: 'permissions', label: 'Permissions' },
            ...(stat()?.dir === false ? [{ value: 'open', label: 'Open with' }] : []),
          ]}
          onChange={(v) => setTab(v as 'about' | 'permissions' | 'open')}
        />
      </Show>
      <Show when={stat()}>
        {(s) => (
          <>
            <Show when={tab() === 'about' || many()}>
              <div class="props">
                <Show when={!many()}>
                  <div class="props-hero">
                    <span
                      class={`fm-icon kind-${kind()} props-icon`}
                      classList={{ folder: s().dir }}
                    >
                      <Show
                        when={kind() === 'image' || kind() === 'video'}
                        fallback={<Icon name={kind() === 'folder' ? 'folder' : 'file'} size={40} />}
                      >
                        <img class="fm-thumb" src={props.mediaThumb(s().path)} alt="" />
                      </Show>
                    </span>
                  </div>
                </Show>
                <dl class="props-grid">
                  <dt>Size</dt>
                  <dd>{sizeText()}</dd>
                  <Show when={!many()}>
                    <dt>Where</dt>
                    <dd class="mono">{s().path.slice(0, s().path.lastIndexOf('/')) || '/'}</dd>
                    <Show when={s().link}>
                      {(l) => (
                        <>
                          <dt>Link to</dt>
                          <dd class="mono">{l()}</dd>
                        </>
                      )}
                    </Show>
                    <dt>Type</dt>
                    <dd>
                      {mime()?.description ?? '…'} <span class="muted">({mime()?.type ?? ''})</span>
                    </dd>
                    <dt>Modified</dt>
                    <dd>{fmtDate(s().modified)}</dd>
                    <dt>Accessed</dt>
                    <dd>{fmtDate(s().accessed)}</dd>
                    <dt>Changed</dt>
                    <dd>{fmtDate(s().changed)}</dd>
                    <dt>On</dt>
                    <dd>
                      <span class="mono">{s().mount}</span>
                      <Show when={s().free !== null && s().total !== null}>
                        <span class="muted">
                          {' '}
                          · {formatBytes(s().free ?? 0)} free of {formatBytes(s().total ?? 0)}
                        </span>
                      </Show>
                    </dd>
                  </Show>
                </dl>
              </div>
            </Show>
            <Show when={tab() === 'permissions' && !many()}>
              <div class="props">
                <dl class="props-grid">
                  <dt>Owner</dt>
                  <dd>{s().owner}</dd>
                  <dt>Group</dt>
                  <dd>{s().group}</dd>
                  <dt>Mode</dt>
                  <dd class="mono">
                    {modeText(s().mode)} ({s().mode.toString(8).padStart(3, '0')})
                  </dd>
                </dl>
                <PermissionRow
                  label="Owner"
                  value={triplets()[0]}
                  dir={s().dir}
                  disabled={!s().mine}
                  onChange={(v) => setTriplet(0, v)}
                />
                <PermissionRow
                  label="Group"
                  value={triplets()[1]}
                  dir={s().dir}
                  disabled={!s().mine}
                  onChange={(v) => setTriplet(1, v)}
                />
                <PermissionRow
                  label="Others"
                  value={triplets()[2]}
                  dir={s().dir}
                  disabled={!s().mine}
                  onChange={(v) => setTriplet(2, v)}
                />
                <Show when={!s().mine}>
                  <p class="muted">Only the owner can change these.</p>
                </Show>
              </div>
            </Show>
            <Show when={tab() === 'open' && !many()}>
              <div class="props">
                <p class="muted">
                  Files of this type ({mime()?.description ?? ''}) open with
                  {defaultApp() === null ? ' no app yet' : ` ${defaultApp()?.name ?? ''}`}.
                </p>
                <Show
                  when={(apps() ?? []).length > 0}
                  fallback={<p class="muted">No app says it opens this type.</p>}
                >
                  <AppRows
                    apps={apps() ?? []}
                    selected={chosenApp() ?? defaultApp()?.id ?? null}
                    server={props.server}
                    label="Apps that open this type"
                    onSelect={setChosenApp}
                  />
                </Show>
                <Button
                  disabled={chosenApp() === null || chosenApp() === defaultApp()?.id}
                  onClick={() => {
                    const id = chosenApp()
                    const t = mime()?.type
                    if (id === null || t === undefined) return
                    void api.setDefaultApp(id, t).then(
                      () =>
                        toast(
                          `${apps()?.find((a) => a.id === id)?.name ?? 'That app'} now opens ${mime()?.description ?? 'this type'}`,
                          { kind: 'success' },
                        ),
                      (e: unknown) => toast(errorText(e), { kind: 'danger' }),
                    )
                  }}
                >
                  Always use this app
                </Button>
              </div>
            </Show>
          </>
        )}
      </Show>
      <Show when={stat.error !== undefined}>
        <p class="muted">{errorText(stat.error)}</p>
      </Show>
    </Dialog>
  )
}

// ---- open with ------------------------------------------------------------------

/** "Open with" for the selection: the kit's card (the design system's Open with). */
export function OpenWithDialog(props: {
  paths: string[]
  server: MediaServer | null
  /** Komble is installed: "Find an app in Komble…" */
  onFindApp?: (() => void) | undefined
  onClose(): void
}): JSX.Element {
  const first = () => props.paths[0] ?? ''
  const [mime] = createResource(first, (p) => api.mimeOf(p))
  const [all, setAll] = createSignal(false)
  const [apps] = createResource(
    () => mime()?.type,
    (type) => api.appsFor(type, false),
  )
  const [everyApp] = createResource(
    () => (all() ? (mime()?.type ?? '') : null),
    (type) => api.appsFor(type, true),
  )
  const open = (app: AppInfo, always: boolean) => {
    const type = mime()?.type
    const before =
      always && type !== undefined ? api.setDefaultApp(app.id, type) : Promise.resolve()
    void before
      .then(() => api.launchWith(app.id, props.paths))
      .then(
        () => props.onClose(),
        (e: unknown) => toast(errorText(e), { kind: 'danger' }),
      )
  }
  return (
    <OpenWith
      open
      subject={props.paths.length === 1 ? baseName(first()) : `${props.paths.length} files`}
      typeLabel={mime()?.description}
      apps={apps()}
      allApps={everyApp()}
      server={props.server}
      onShowAll={() => setAll(true)}
      onFindApp={props.onFindApp}
      onOpen={open}
      onClose={() => props.onClose()}
    />
  )
}

// ---- connect to server ----------------------------------------------------------

const SCHEMES = [
  { value: 'smb', label: 'Windows share', hint: 'smb://server/share' },
  { value: 'sftp', label: 'SSH', hint: 'sftp://user@host/folder' },
  { value: 'ftp', label: 'FTP', hint: 'ftp://host' },
  { value: 'davs', label: 'WebDAV', hint: 'davs://host/remote.php/webdav' },
]

export function ConnectDialog(props: {
  onConnect(uri: string): void
  onClose(): void
}): JSX.Element {
  const [scheme, setScheme] = createSignal('smb')
  const [uri, setUri] = createSignal('smb://')
  const submit = () => {
    const u = uri().trim()
    if (!u.includes('://') || u.endsWith('://')) return
    props.onConnect(u)
  }
  return (
    <Dialog
      open
      title="Connect to a server"
      description="Type the address. You will be asked for a password if the server needs one."
      onClose={() => props.onClose()}
      actions={
        <>
          <Button kind="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button kind="primary" onClick={submit}>
            Connect
          </Button>
        </>
      }
    >
      <Segmented
        value={scheme()}
        label="Kind of server"
        options={SCHEMES.map((s) => ({ value: s.value, label: s.label }))}
        onChange={(v) => {
          setScheme(v)
          const rest = uri().replace(/^[a-z]+:\/\//, '')
          setUri(`${v}://${rest}`)
        }}
      />
      <Field
        value={uri()}
        label="Address"
        mono
        placeholder={SCHEMES.find((s) => s.value === scheme())?.hint}
        autofocus
        onInput={setUri}
        onSubmit={submit}
      />
      <p class="muted">For example {SCHEMES.find((s) => s.value === scheme())?.hint}</p>
    </Dialog>
  )
}

export function CredentialsDialog(props: { ask: MountAsk; onDone(): void }): JSX.Element {
  const [user, setUser] = createSignal(props.ask.defaultUser)
  const [domain, setDomain] = createSignal(props.ask.defaultDomain)
  const [password, setPassword] = createSignal('')
  const [anonymous, setAnonymous] = createSignal(false)
  const [remember, setRemember] = createSignal(false)
  const reply = (cancel: boolean) => {
    void api.mountReply({
      id: props.ask.id,
      cancel,
      username: user(),
      password: password(),
      domain: domain(),
      anonymous: anonymous(),
      remember: remember(),
    })
    props.onDone()
  }
  return (
    <Dialog
      open
      title="Sign in"
      description={props.ask.message}
      onClose={() => reply(true)}
      actions={
        <>
          <Button kind="ghost" onClick={() => reply(true)}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => reply(false)}>
            Connect
          </Button>
        </>
      }
    >
      <Show when={props.ask.anonymousOk}>
        <label class="row-switch">
          <Switch checked={anonymous()} label="Connect without a name" onChange={setAnonymous} />
          <span>Connect without a name (guest)</span>
        </label>
      </Show>
      <Show when={!anonymous()}>
        <Show when={props.ask.needsUsername}>
          <Field
            value={user()}
            label="User name"
            placeholder="User name"
            autofocus
            onInput={setUser}
          />
        </Show>
        <Show when={props.ask.needsDomain}>
          <Field value={domain()} label="Domain" placeholder="Domain" onInput={setDomain} />
        </Show>
        <Show when={props.ask.needsPassword}>
          <label class="field">
            <span class="field-icon">
              <Icon name="lock" />
            </span>
            <input
              class="field-input"
              type="password"
              value={password()}
              aria-label="Password"
              placeholder="Password"
              onInput={(e) => setPassword(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') reply(false)
              }}
            />
          </label>
        </Show>
        <Show when={props.ask.canRemember}>
          <label class="row-switch">
            <Switch checked={remember()} label="Remember the password" onChange={setRemember} />
            <span>Remember the password</span>
          </label>
        </Show>
      </Show>
    </Dialog>
  )
}

export function QuestionDialog(props: { q: MountQuestion; onDone(): void }): JSX.Element {
  const answer = (choice: number | null) => {
    void api.mountReply({ id: props.q.id, cancel: choice === null, choice: choice ?? 0 })
    props.onDone()
  }
  return (
    <Dialog
      open
      title="A question from the server"
      description={props.q.message}
      onClose={() => answer(null)}
      actions={
        <For each={props.q.choices}>
          {(c, i) => (
            <Button
              kind={i() === props.q.choices.length - 1 ? 'primary' : 'secondary'}
              onClick={() => answer(i())}
            >
              {c}
            </Button>
          )}
        </For>
      }
    />
  )
}

// ---- batch rename ---------------------------------------------------------------

export function RenameManyDialog(props: {
  entries: AppEntry[]
  onRename(pairs: { path: string; name: string }[]): void
  onClose(): void
}): JSX.Element {
  const [rule, setRule] = createSignal<BatchRename>({ ...DEFAULT_BATCH_RENAME })
  const patch = (p: Partial<BatchRename>) => setRule((r) => ({ ...r, ...p }))
  const names = createMemo(() => batchRenameNames(props.entries, rule()))
  const problems = createMemo(() => {
    const seen = new Set<string>()
    let bad = 0
    for (const n of names()) {
      if (!isFileName(n) || seen.has(n)) bad++
      seen.add(n)
    }
    return bad
  })
  const changed = () => names().filter((n, i) => n !== props.entries[i]?.name).length
  const submit = () => {
    if (problems() > 0 || changed() === 0) return
    props.onRename(
      props.entries
        .map((e, i) => ({ path: e.path, name: names()[i] ?? e.name }))
        .filter((p, i) => p.name !== props.entries[i]?.name),
    )
  }
  return (
    <Dialog
      open
      wide
      title={`Rename ${props.entries.length} items`}
      description="The extension stays as it is. {n} in a name is where the number goes."
      onClose={() => props.onClose()}
      actions={
        <>
          <Button kind="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button kind="primary" disabled={problems() > 0 || changed() === 0} onClick={submit}>
            Rename {changed() > 0 ? changed() : ''}
          </Button>
        </>
      }
    >
      <div class="rename-grid">
        <Field
          value={rule().find}
          label="Find"
          placeholder="Find"
          autofocus
          onInput={(v) => patch({ find: v })}
          onSubmit={submit}
        />
        <Field
          value={rule().replace}
          label="Replace with"
          placeholder="Replace with"
          onInput={(v) => patch({ replace: v })}
          onSubmit={submit}
        />
        <Field
          value={rule().prefix}
          label="Add before"
          placeholder="Add before"
          onInput={(v) => patch({ prefix: v })}
        />
        <Field
          value={rule().suffix}
          label="Add after"
          placeholder="Add after"
          onInput={(v) => patch({ suffix: v })}
        />
      </div>
      <div class="rename-row">
        <span class="muted">Numbering</span>
        <Segmented
          small
          value={String(rule().numberDigits)}
          label="Numbering"
          options={[
            { value: '0', label: 'Off' },
            { value: '1', label: '1, 2, 3' },
            { value: '2', label: '01, 02' },
            { value: '3', label: '001' },
          ]}
          onChange={(v) => patch({ numberDigits: Number(v) })}
        />
        <Show when={rule().numberDigits > 0}>
          <Field
            small
            value={String(rule().numberStart)}
            label="Start at"
            mono
            onInput={(v) => patch({ numberStart: Math.max(0, Number(v) || 0) })}
          />
        </Show>
      </div>
      <div class="rename-row">
        <span class="muted">Case</span>
        <Segmented
          small
          value={rule().case}
          label="Case"
          options={[
            { value: 'keep', label: 'Keep' },
            { value: 'lower', label: 'lower' },
            { value: 'upper', label: 'UPPER' },
            { value: 'title', label: 'Title' },
          ]}
          onChange={(v) => patch({ case: v as BatchRename['case'] })}
        />
      </div>
      <div class="rename-preview">
        <For each={props.entries.slice(0, 60)}>
          {(e, i) => (
            <div
              class="rename-line"
              classList={{ changed: names()[i()] !== e.name, bad: !isFileName(names()[i()] ?? '') }}
            >
              <span class="rename-old">{e.name}</span>
              <Icon name="arrow-right" size={12} />
              <span class="rename-new">{names()[i()]}</span>
            </div>
          )}
        </For>
        <Show when={props.entries.length > 60}>
          <div class="muted">and {props.entries.length - 60} more…</div>
        </Show>
      </div>
      <Show when={problems() > 0}>
        <p class="danger-text">{problems()} of the new names clash or are not allowed.</p>
      </Show>
    </Dialog>
  )
}

// ---- compress -------------------------------------------------------------------

export function CompressDialog(props: {
  paths: string[]
  sevenZip: boolean
  onCreate(name: string, format: CompressFormat): void
  onClose(): void
}): JSX.Element {
  const base = () => (props.paths.length === 1 ? baseName(props.paths[0] ?? '') : 'Archive')
  const [name, setName] = createSignal(base())
  const [format, setFormat] = createSignal<CompressFormat>('zip')
  const submit = () => {
    if (!isFileName(name().trim())) return
    props.onCreate(name().trim(), format())
  }
  return (
    <Dialog
      open
      title="Compress"
      description={`${props.paths.length} item${props.paths.length === 1 ? '' : 's'} into one archive, next to them.`}
      onClose={() => props.onClose()}
      actions={
        <>
          <Button kind="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!isFileName(name().trim())} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <Field value={name()} label="Archive name" autofocus onInput={setName} onSubmit={submit} />
      <Segmented
        value={format()}
        label="Format"
        options={COMPRESS_FORMATS.filter((f) => f !== '7z' || props.sevenZip).map((f) => ({
          value: f,
          label: `.${f}`,
        }))}
        onChange={(v) => setFormat(v as CompressFormat)}
      />
      <p class="muted">
        {format() === 'zip'
          ? 'Opens everywhere.'
          : format() === '7z'
            ? 'Smallest files; needs 7-Zip to open.'
            : format() === 'tar.zst'
              ? 'Fast and small; for Linux.'
              : 'The classic for Linux.'}
      </p>
    </Dialog>
  )
}

// ---- run a program --------------------------------------------------------------

export function RunDialog(props: {
  entry: AppEntry
  komble: boolean
  onRun(terminal: boolean): void
  onInstall(): void
  onView(): void
  onClose(): void
}): JSX.Element {
  const appImage = () => isAppImage(props.entry.name)
  return (
    <Dialog
      open
      title={`“${props.entry.name}” is a program`}
      description={
        appImage()
          ? 'AppImages run straight from the file. Komble can install it so it shows up in the launcher and gets updates.'
          : 'Run it, or look at what is inside. Only run programs you trust.'
      }
      onClose={() => props.onClose()}
      actions={
        <>
          <Button kind="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Show when={!appImage()}>
            <Button onClick={() => props.onView()}>Show the text</Button>
            <Button onClick={() => props.onRun(true)}>Run in a terminal</Button>
          </Show>
          <Show when={appImage() && props.komble}>
            <Button onClick={() => props.onInstall()}>Install with Komble</Button>
          </Show>
          <Button kind="primary" onClick={() => props.onRun(false)}>
            Run
          </Button>
        </>
      }
    />
  )
}

// ---- archives -------------------------------------------------------------------

export function ArchiveDialog(props: {
  name: string
  listing: ArchiveListing | null
  error: string | null
  busy: boolean
  onExtract(): void
  onExtractTo(): void
  onOpenWith(): void
  onClose(): void
}): JSX.Element {
  const summary = () => {
    const l = props.listing
    if (l === null) return props.error ?? 'Reading the archive…'
    return `${l.count} file${l.count === 1 ? '' : 's'} · ${formatBytes(l.size)} unpacked`
  }
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && props.listing !== null && !props.busy) props.onExtract()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    onCleanup(() => window.removeEventListener('keydown', onKey, true))
  })
  return (
    <Dialog
      open
      wide
      title={props.name}
      description={summary()}
      onClose={() => props.onClose()}
      actions={
        <>
          <Button kind="ghost" onClick={() => props.onOpenWith()}>
            Open with…
          </Button>
          <span class="toolbar-spacer" />
          <Button
            disabled={props.listing === null || props.busy}
            onClick={() => props.onExtractTo()}
          >
            Extract to…
          </Button>
          <Button
            kind="primary"
            disabled={props.listing === null || props.busy}
            onClick={() => props.onExtract()}
          >
            {props.busy ? 'Extracting…' : 'Extract here'}
          </Button>
        </>
      }
    >
      <div class="ad-list">
        <For each={props.listing?.entries ?? []}>
          {(item) => {
            const slash = item.name.lastIndexOf('/')
            return (
              <div class="ad-row" classList={{ dir: item.dir }}>
                <Icon name={item.dir ? 'folder' : 'file'} size={14} />
                <span class="ad-path">
                  <Show when={slash > 0}>
                    <span class="ad-parent">{item.name.slice(0, slash + 1)}</span>
                  </Show>
                  {item.name.slice(slash + 1)}
                </span>
                <span class="ad-size">{item.dir ? '' : formatBytes(item.size)}</span>
              </div>
            )
          }}
        </For>
        <Show when={props.listing?.truncated}>
          <div class="ad-more">and more…</div>
        </Show>
        <Show when={props.error !== null}>
          <div class="tv-message">
            <Icon name="circle-alert" size={20} />
            <span>{props.error}</span>
          </div>
        </Show>
      </div>
      <p class="muted">
        {props.listing === null
          ? ''
          : props.listing.root === null
            ? 'Extract here makes a folder named after the archive.'
            : `Extract here makes the folder “${props.listing.root}”.`}
      </p>
    </Dialog>
  )
}

export function PathDialog(props: {
  title: string
  description: string
  action: string
  initial: string
  home: string
  onPick(path: string): void
  onClose(): void
}): JSX.Element {
  const [value, setValue] = createSignal(props.initial)
  const submit = () => {
    const v = value().trim()
    if (v !== '') props.onPick(v)
  }
  return (
    <Dialog
      open
      title={props.title}
      description={props.description}
      onClose={() => props.onClose()}
      actions={
        <>
          <Button kind="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button kind="primary" onClick={submit}>
            {props.action}
          </Button>
        </>
      }
    >
      <Field value={value()} label="Folder" mono autofocus onInput={setValue} onSubmit={submit} />
      <p class="muted">{tildePath(value(), props.home)}</p>
    </Dialog>
  )
}

export function ConfirmDialog(props: {
  title: string
  description: string
  action: string
  danger?: boolean | undefined
  onConfirm(): void
  onClose(): void
}): JSX.Element {
  return (
    <Dialog
      open
      title={props.title}
      description={props.description}
      onClose={() => props.onClose()}
      actions={
        <>
          <Button kind="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button
            kind="primary"
            class={props.danger === true ? 'btn--danger' : undefined}
            onClick={() => props.onConfirm()}
          >
            {props.action}
          </Button>
        </>
      }
    />
  )
}

/** Keeps a stat fresh while a dialog is open (shared helper for the preview pane). */
export function useStat(path: () => string | null): () => PathStat | undefined {
  const [s, { refetch }] = createResource(path, (p) => api.stat(p))
  createEffect(on(path, () => void refetch(), { defer: true }))
  return s
}
