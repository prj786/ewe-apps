import { For, Show, createEffect, createMemo, createSignal, on, onMount, type JSX } from 'solid-js'
import { rawUrl, type AppInfo, type MediaServer } from '@ewe/shared'
import { Dialog } from './Dialog'
import { EmptyState } from './EmptyState'
import { Field } from './Field'
import { Icon } from './Icon'
import { Switch } from './Switch'
import { Button } from './Toolbar'

/** An app's own icon from the icon theme; the app glyph when it has none. */
function AppIcon(props: { app: AppInfo; server: MediaServer | null }): JSX.Element {
  const [failed, setFailed] = createSignal(false)
  const url = () => {
    const path = props.app.iconPath
    return props.server === null || path === undefined || path === null || failed()
      ? null
      : rawUrl(props.server, path)
  }
  return (
    <span class="approw-icon">
      <Show when={url()} fallback={<Icon name="app-window" />}>
        {(src) => (
          <img
            src={src()}
            alt=""
            draggable={false}
            decoding="async"
            onError={() => setFailed(true)}
          />
        )}
      </Show>
    </span>
  )
}

/**
 * The rows of an app list (design system: File picker → Open with): the app's icon
 * and name on a `control-2xl` row, the chosen one in `accent-subtle` with a check.
 * Six rows show, then the list scrolls. ↑ and ↓ move the choice, Enter takes it.
 */
export function AppRows(props: {
  apps: AppInfo[]
  selected: string | null
  server: MediaServer | null
  label: string
  onSelect(id: string): void
  /** a double click, or Enter on a row */
  onTake?: ((id: string) => void) | undefined
  ref?: ((el: HTMLDivElement) => void) | undefined
}): JSX.Element {
  let list: HTMLDivElement | undefined
  const move = (delta: number) => {
    const i = props.apps.findIndex((a) => a.id === props.selected)
    const next = props.apps[Math.min(props.apps.length - 1, Math.max(0, i + delta))]
    if (next === undefined) return
    props.onSelect(next.id)
    queueMicrotask(() => {
      const row = list?.querySelector<HTMLElement>(`[data-app="${CSS.escape(next.id)}"]`)
      row?.focus()
      row?.scrollIntoView({ block: 'nearest' })
    })
  }
  return (
    <div
      ref={(el) => {
        list = el
        props.ref?.(el)
      }}
      class="applist"
      role="listbox"
      aria-label={props.label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') move(1)
        else if (e.key === 'ArrowUp') move(-1)
        else if (e.key === 'Home') move(-props.apps.length)
        else if (e.key === 'End') move(props.apps.length)
        else if (e.key === 'Enter' && props.selected !== null && props.onTake !== undefined)
          props.onTake(props.selected)
        else return
        e.preventDefault()
      }}
    >
      <For each={props.apps}>
        {(app) => (
          <button
            type="button"
            class="approw"
            role="option"
            classList={{ selected: props.selected === app.id }}
            aria-selected={props.selected === app.id}
            tabindex={props.selected === app.id ? 0 : -1}
            data-app={app.id}
            onClick={() => props.onSelect(app.id)}
            onDblClick={() => props.onTake?.(app.id)}
          >
            <AppIcon app={app} server={props.server} />
            <span class="approw-name" dir="auto">
              {app.name}
            </span>
            <Show when={app.default}>
              <span class="approw-note">Default</span>
            </Show>
            <Icon name="check" class="approw-check" />
          </button>
        )}
      </For>
    </div>
  )
}

export interface OpenWithProps {
  open: boolean
  /** what is being opened: the file's name, or "3 files" */
  subject: string
  /** the type in words ("JPEG image"): the "Always" switch names it. Without it —
   *  several types at once — there is no switch. */
  typeLabel?: string | undefined
  /** the apps that say they open this type, the default first; undefined while asked */
  apps: AppInfo[] | undefined
  /** every app, once "Other apps…" asked for them; undefined until then */
  allApps?: AppInfo[] | undefined
  server: MediaServer | null
  onShowAll?: (() => void) | undefined
  /** "Find an app in Komble…" (left out when Komble is not there) */
  onFindApp?: (() => void) | undefined
  onOpen(app: AppInfo, always: boolean): void
  onClose(): void
}

/**
 * "Open with" (design system: File picker → Open with), the same card the desktop
 * draws when another app asks: a 400px dialog, the apps with their own icons, the one
 * that opens this type first and chosen, Cancel and Open — and "Find an app in
 * Komble…" on the left.
 */
export function OpenWith(props: OpenWithProps): JSX.Element {
  const [chosen, setChosen] = createSignal<string | null>(null)
  const [always, setAlways] = createSignal(false)
  const [all, setAll] = createSignal(false)
  const [filter, setFilter] = createSignal('')
  let rows: HTMLDivElement | undefined

  const list = createMemo<AppInfo[]>(() => {
    if (!all()) return props.apps ?? []
    const q = filter().trim().toLowerCase()
    const every = props.allApps ?? []
    return q === '' ? every : every.filter((a) => a.name.toLowerCase().includes(q))
  })
  const selected = createMemo(() => {
    const id = chosen()
    const rowsNow = list()
    return rowsNow.some((a) => a.id === id) ? id : (rowsNow[0]?.id ?? null)
  })
  const loading = () => (all() ? props.allApps === undefined : props.apps === undefined)

  const take = (id: string | null) => {
    const app = list().find((a) => a.id === id)
    if (app !== undefined) props.onOpen(app, always())
  }
  const focusRow = () => {
    if (document.activeElement instanceof HTMLInputElement) return
    rows?.querySelector<HTMLElement>('.approw.selected')?.focus()
  }

  // a fresh start each time the dialog opens
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setChosen(null)
        setAlways(false)
        setAll(false)
        setFilter('')
        setTimeout(focusRow, 0)
      },
    ),
  )
  // the keyboard starts on the chosen row (↑ ↓ Enter), also when the apps arrive late
  onMount(() => setTimeout(focusRow, 0))
  createEffect(
    on(
      () => props.apps,
      () => setTimeout(focusRow, 0),
      { defer: true },
    ),
  )

  return (
    <Dialog
      open={props.open}
      title="Open with"
      description={`Choose an app for “${props.subject}”.`}
      onClose={() => props.onClose()}
      actions={
        <>
          <Show when={props.onFindApp}>
            {(find) => (
              <Button kind="ghost" class="dialog-actions-start" onClick={() => find()()}>
                Find an app in Komble…
              </Button>
            )}
          </Show>
          <Button kind="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button kind="primary" disabled={selected() === null} onClick={() => take(selected())}>
            Open
          </Button>
        </>
      }
    >
      <div class="openwith">
        <Show when={all()}>
          <Field
            value={filter()}
            label="Find an app"
            placeholder="Find an app"
            icon="search"
            clearable
            autofocus
            class="openwith-find"
            onInput={setFilter}
            onSubmit={() => take(selected())}
          />
        </Show>
        <Show
          when={list().length > 0}
          fallback={
            <Show when={!loading()}>
              <EmptyState
                icon="app-window"
                title={all() ? 'No app with that name' : 'No app opens this yet'}
                compact
              >
                {all() || props.onFindApp === undefined ? undefined : 'Komble can find one.'}
              </EmptyState>
            </Show>
          }
        >
          <AppRows
            ref={(el) => (rows = el)}
            apps={list()}
            selected={selected()}
            server={props.server}
            label="Apps"
            onSelect={setChosen}
            onTake={take}
          />
        </Show>
        <Show when={!all() && props.onShowAll !== undefined}>
          <button
            type="button"
            class="approw approw--more"
            onClick={() => {
              setAll(true)
              props.onShowAll?.()
            }}
          >
            <span class="approw-icon">
              <Icon name="ellipsis" />
            </span>
            <span class="approw-name">Other apps…</span>
          </button>
        </Show>
        <Show when={props.typeLabel}>
          {(type) => (
            <label class="openwith-always">
              <Switch
                checked={always()}
                label={`Always use this app for ${type()} files`}
                onChange={setAlways}
              />
              <span>Always use this app for {type()} files</span>
            </label>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
