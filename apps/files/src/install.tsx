// Installing an app from its card (eep/docs/CARD.md): the app's icon and name over
// the Install button. Install moves the card into Applications — eep fetches the app
// and says how far it is — and then the button opens it. One view, shown two ways:
// a dialog in a Files window (a double-click on a card that is not in Applications),
// and the whole of the small window eep's card handler opens for a card clicked
// anywhere else (`ewe-files-app --install=<card>`).

import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
} from 'solid-js'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  activityBytes,
  activityFraction,
  appIconUrl,
  appOrigin,
  formatBytes,
  type EepActivity,
  type MediaServer,
} from '@ewe/shared'
import { Button, Icon, ProgressBar, Toasts, applyShotSize, getMediaServer } from '@ewe/ui'
import { api, errorText, on as onEvent, windowLabel } from './api'

let nextAdd = 1
/** An id for one `eep add` (its answer comes back as `eep-add` with it). */
export const newAddId = (): number => nextAdd++

/** What eep is installing right now, kept fresh. */
export function useEepActivity(): Accessor<EepActivity[]> {
  const [activity, setActivity] = createSignal<EepActivity[]>([])
  onMount(() => {
    // listen first, then ask: what is said in between must not be lost, and an
    // answer that comes after an event is older than the event
    let heard = false
    onCleanup(
      onEvent('eep-activity', (list) => {
        heard = true
        setActivity(list)
      }),
    )
    void api.eepActivity().then(
      (list) => {
        if (!heard) setActivity(list)
      },
      () => undefined,
    )
  })
  return activity
}

/** An install that goes on after its view closed: whoever stays tells how it ended. */
export interface BackgroundAdd {
  id: number
  name: string
}

type Phase = 'ask' | 'installing' | 'done' | 'failed'

export interface InstallViewProps {
  /** the card file */
  path: string
  server: MediaServer | null
  /** eep is installed */
  eep: boolean
  activity: EepActivity[]
  /** Close the view. `background` is our `eep add` when it is still running. */
  onClose(background: BackgroundAdd | null): void
  /** The view went away without being closed (another dialog took its place) while
   *  its `eep add` was running. */
  onLeave?(background: BackgroundAdd): void
  /** the app's name once it is known (a window's title) */
  onName?(name: string): void
  /** Hands out the view's own close: it knows whether its install is still running
   *  (what a corner button or Escape should do). */
  bind?(close: () => void): void
}

export function InstallView(props: InstallViewProps): JSX.Element {
  const [card, { refetch }] = createResource(
    () => props.path,
    (path) => api.eepCard(path),
  )
  // null: as eep says; set once the user pressed a button here
  const [phase, setPhase] = createSignal<Phase | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  // the app's card in Applications, once eep said where it went
  const [installed, setInstalled] = createSignal<string | null>(null)
  const [iconFailed, setIconFailed] = createSignal(false)
  let request: number | null = null
  let cancelled = false
  let primary: HTMLButtonElement | undefined

  const loaded = () => (card.error === undefined ? card() : undefined)
  const app = () => loaded()?.app
  const info = () => loaded()?.info ?? null
  const name = () => app()?.name ?? ''
  const live = createMemo(() => {
    const id = app()?.id
    return id === undefined ? undefined : props.activity.find((a) => a.id === id)
  })
  const state = createMemo<Phase>(() => {
    const chosen = phase()
    if (chosen !== null) return chosen
    if (info()?.ready === true) return 'done'
    const a = live()
    return a !== undefined && a.state !== 'failed' ? 'installing' : 'ask'
  })
  // an install somebody else started (the card was dropped into Applications) ended:
  // ask eep again whether the app is ready
  createEffect(
    on(live, (now, before) => {
      if (before !== undefined && now === undefined && phase() === null) void refetch()
    }),
  )
  createEffect(() => {
    const n = name()
    if (n !== '') props.onName?.(n)
  })
  // Enter is the button that matters
  createEffect(on([state, () => card.loading], () => queueMicrotask(() => primary?.focus())))

  onMount(() => {
    onCleanup(
      onEvent('eep-add', (r) => {
        if (r.window !== windowLabel() || r.id !== request) return
        request = null
        if (cancelled) {
          // its card is in the Trash: whatever eep answered, there is nothing to open
          props.onClose(null)
          return
        }
        if (r.card !== null) setInstalled(r.card)
        if (r.ok) setPhase('done')
        else {
          setError(r.error ?? 'It could not be installed')
          setPhase('failed')
        }
      }),
    )
  })

  /** the card in Applications (after Install the download is not where it was) */
  const there = () => installed() ?? live()?.card ?? info()?.installed ?? null

  const install = () => {
    if (!props.eep) return
    cancelled = false
    setError(null)
    setPhase('installing')
    const id = newAddId()
    request = id
    api.eepAdd(there() ?? props.path, id).catch((e: unknown) => {
      request = null
      setError(errorText(e))
      setPhase('failed')
    })
  }

  const running = (): BackgroundAdd | null =>
    request === null ? null : { id: request, name: name() || 'The app' }
  let closed = false
  const close = () => {
    closed = true
    props.onClose(running())
  }
  onMount(() => props.bind?.(close))
  onCleanup(() => {
    const still = running()
    if (!closed && still !== null) props.onLeave?.(still)
  })

  /** Stop: the card leaves Applications (to the Trash), and eep drops the download. */
  const cancel = () => {
    const path = there()
    if (path === null) return
    cancelled = true
    api.opStart('trash', [path], null).then(
      () => {
        if (request === null) props.onClose(null)
      },
      (e: unknown) => {
        cancelled = false
        setError(errorText(e))
      },
    )
  }

  const open = () => {
    api.eepOpen(there() ?? props.path, 0).then(
      () => props.onClose(null),
      (e: unknown) => setError(errorText(e)),
    )
  }

  const icon = () => {
    const c = loaded()
    const s = props.server
    if (c === undefined || s === null || !c.app.icon || iconFailed()) return null
    // the same picture, from where the card is now
    const moved = installed()
    return moved === null ? appIconUrl(s, c.path, c.mtime) : appIconUrl(s, moved, 0)
  }

  const fraction = () => activityFraction(live())
  const words = (...parts: string[]) => parts.filter((x) => x !== '').join(' · ')
  /** the line under the name: what this is, or how far it is */
  const line = (): string => {
    if (card.loading) return ''
    const a = app()
    if (a === undefined) return 'This file is not an app'
    switch (state()) {
      case 'ask': {
        if (!props.eep) return 'To install it, update ewe: it brings eep, the app manager'
        if (a.system)
          return info()?.present === false
            ? 'It is not on this computer (the card came from another one)'
            : words(appOrigin(a), a.version)
        const size = info()?.download
        return words(
          a.version === '' ? '' : `Version ${a.version}`,
          size === undefined || size <= 0 ? '' : `${formatBytes(size)} to download`,
        )
      }
      case 'installing': {
        const l = live()
        if (l === undefined || l.state === 'waiting') return 'Getting ready…'
        if (l.state === 'finishing') return 'Finishing…'
        const f = fraction()
        const bytes = activityBytes(l)
        return words(
          f === null ? 'Installing…' : `Installing… ${Math.floor(f * 100)}%`,
          bytes === null ? '' : `${formatBytes(bytes.done)} of ${formatBytes(bytes.total)}`,
        )
      }
      case 'done':
        return phase() === 'done' ? 'Installed' : 'Already installed'
      case 'failed':
        return 'It could not be installed'
    }
  }
  const absent = () => app()?.system === true && info()?.present === false

  return (
    <div class="install" classList={{ [state()]: true }}>
      <span class="install-icon" classList={{ dim: state() === 'installing' }}>
        <Show when={icon()} fallback={<Icon name="app-window" size={40} />}>
          {(src) => (
            <img src={src()} alt="" draggable={false} onError={() => setIconFailed(true)} />
          )}
        </Show>
      </span>
      <h2 class="install-name" dir="auto">
        {card.loading ? ' ' : name() || 'Not an app'}
      </h2>
      <p class="install-line">{line()}</p>
      <Show when={state() === 'installing'}>
        <ProgressBar
          class="install-progress"
          value={live()?.state === 'finishing' ? 1 : fraction()}
          label={`Installing ${name()}`}
        />
      </Show>
      <Show when={error()}>{(text) => <p class="install-error">{text()}</p>}</Show>
      <div class="install-actions">
        <Switch>
          <Match when={!card.loading && (app() === undefined || absent())}>
            <button
              type="button"
              class="btn btn--primary"
              ref={primary}
              onClick={() => props.onClose(null)}
            >
              Close
            </button>
          </Match>
          <Match when={state() === 'ask'}>
            <button
              type="button"
              class="btn btn--primary"
              ref={primary}
              disabled={!props.eep || card.loading}
              onClick={install}
            >
              {app()?.system === true ? 'Add to Applications' : 'Install'}
            </button>
            <Button kind="ghost" onClick={() => props.onClose(null)}>
              Not now
            </Button>
          </Match>
          <Match when={state() === 'installing'}>
            <button type="button" class="btn btn--secondary" ref={primary} onClick={close}>
              Hide
            </button>
            <Show when={there() !== null}>
              <Button kind="ghost" onClick={cancel}>
                Cancel
              </Button>
            </Show>
          </Match>
          <Match when={state() === 'done'}>
            <button type="button" class="btn btn--primary" ref={primary} onClick={open}>
              Open
            </button>
            <Button kind="ghost" onClick={() => props.onClose(null)}>
              Done
            </Button>
          </Match>
          <Match when={state() === 'failed'}>
            <button type="button" class="btn btn--primary" ref={primary} onClick={install}>
              Try again
            </button>
            <Button kind="ghost" onClick={() => props.onClose(null)}>
              Close
            </Button>
          </Match>
        </Switch>
      </div>
    </div>
  )
}

/** The Install view as a dialog over a Files window. Escape, the corner button and a
 *  click outside hide it; an install that is running goes on. */
export function InstallDialog(props: InstallViewProps): JSX.Element {
  const [name, setName] = createSignal('')
  // the view's own close, once it is there (it knows whether its install still runs)
  const closer = { run: () => props.onClose(null) }
  const close = () => closer.run()
  return (
    <div
      class="dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        class="dialog install-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={name() === '' ? 'Install an app' : `Install ${name()}`}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          close()
        }}
      >
        <button
          type="button"
          class="iconbtn iconbtn--sm install-x"
          aria-label="Close"
          onClick={() => close()}
        >
          <Icon name="x" />
        </button>
        <InstallView
          path={props.path}
          server={props.server}
          eep={props.eep}
          activity={props.activity}
          onClose={(background) => props.onClose(background)}
          onLeave={(background) => props.onLeave?.(background)}
          onName={setName}
          bind={(c) => {
            closer.run = c
          }}
        />
      </div>
    </div>
  )
}

/** The Install view as a window of its own (`--install=<card>`). */
export function InstallWindow(): JSX.Element {
  const [server, setServer] = createSignal<MediaServer | null>(null)
  const [eep, setEep] = createSignal(true)
  const [path, setPath] = createSignal<string | null>(null)
  const activity = useEepActivity()
  // an install that is running goes on without the window (it is eep's own process)
  const close = () => void getCurrentWindow().close()
  onMount(() => {
    void getMediaServer().then(setServer)
    void api.tools().then((t) => setEep(t.eep))
    void api.windowLaunch().then((l) => {
      applyShotSize(l.flags)
      const flag = l.flags.find((f) => f.startsWith('--install='))
      setPath(flag === undefined ? '' : flag.slice('--install='.length))
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', () => void api.windowClosed())
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })
  return (
    <div class="app install-window">
      <button
        type="button"
        class="iconbtn iconbtn--sm install-x"
        aria-label="Close"
        onClick={close}
      >
        <Icon name="x" />
      </button>
      <Show when={path() !== null}>
        <InstallView
          path={path() ?? ''}
          server={server()}
          eep={eep()}
          activity={activity()}
          onClose={close}
          onName={(name) => void getCurrentWindow().setTitle(`Install ${name}`)}
        />
      </Show>
      <Toasts />
    </div>
  )
}
