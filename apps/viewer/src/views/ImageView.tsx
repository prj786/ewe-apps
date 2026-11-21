// Pictures: fit / actual size, zoom (wheel, pinch, keys) and pan (drag), rotate, flip,
// slideshow, stepping through the folder, an info panel with EXIF, copy, set as
// wallpaper, move to Trash. GIF/WebP/AVIF/SVG animate by themselves in <img>; HEIC/HEIF
// (phone pictures, which WebKitGTK cannot decode) come as a JPEG the core converts once.

import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  type JSX,
} from 'solid-js'
import { formatBytes, pictureUrl } from '@ewe/shared'
import {
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Menu,
  Switch as Toggle,
  Toolbar,
  addRecent,
  toast,
  type MenuEntry,
} from '@ewe/ui'
import { invoke } from '@tauri-apps/api/core'
import type { AppInfo, MimeInfo } from '@ewe/shared'
import {
  copyImage,
  folderImages,
  imageInfo,
  setWallpaper,
  trashFile,
  type ImageInfo,
} from '../lib/bridge'
import { exifRows } from '../lib/exif'
import { inTextInput, isMod, useKeys } from '../lib/keys'
import { baseName, dirName } from '../lib/kinds'
import { getSetting, setSetting } from '../lib/store'
import { flagNumber, hasFlag } from '../lib/flags'
import { percent, zoomStep, type ViewProps } from './types'

const MIN_ZOOM = 0.05
const MAX_ZOOM = 32

export function ImageView(props: ViewProps): JSX.Element {
  const [current, setCurrent] = createSignal(props.path)
  const [siblings, setSiblings] = createSignal<string[]>([])
  const [fit, setFit] = createSignal(true)
  const [zoom, setZoom] = createSignal(1)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  const [rotation, setRotation] = createSignal(0)
  const [flipH, setFlipH] = createSignal(false)
  const [flipV, setFlipV] = createSignal(false)
  const [natural, setNatural] = createSignal<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = createSignal(false)
  const flags = () => props.flags ?? []
  const [info, setInfo] = createSignal(hasFlag(flags(), 'info') || getSetting('imageInfo', false))
  const [slideshow, setSlideshow] = createSignal(hasFlag(flags(), 'slideshow'))
  const [slideSeconds, setSlideSeconds] = createSignal(getSetting('slideSeconds', 4))
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null)
  const [confirmTrash, setConfirmTrash] = createSignal(false)
  const [openWith, setOpenWith] = createSignal<AppInfo[] | null>(null)
  const [dragging, setDragging] = createSignal(false)
  const [checker, setChecker] = createSignal(getSetting('imageChecker', false))

  let stage: HTMLDivElement | undefined
  let img: HTMLImageElement | undefined

  const name = () => baseName(current())
  const index = () => siblings().indexOf(current())
  const count = () => siblings().length

  const [details] = createResource(current, (path) =>
    imageInfo(path).catch((): ImageInfo | null => null),
  )
  const [mime] = createResource(current, (path) =>
    invoke<MimeInfo>('mime_of', { path }).catch((): MimeInfo | null => null),
  )

  createEffect(
    on(
      () => props.path,
      (p) => {
        setCurrent(p)
        void folderImages(p)
          .then((list) => setSiblings(list.includes(p) ? list : [p, ...list]))
          .catch(() => setSiblings([p]))
      },
    ),
  )

  createEffect(
    on(current, (p) => {
      setFailed(false)
      setNatural(null)
      setFit(true)
      setZoom(1)
      setPan({ x: 0, y: 0 })
      setRotation(0)
      setFlipH(false)
      setFlipV(false)
      void addRecent(p).catch(() => undefined)
      // warm the neighbours
      for (const delta of [1, -1]) {
        const next = siblings()[(index() + delta + count()) % count()]
        if (next !== undefined && next !== p) new Image().src = pictureUrl(props.server, next)
      }
    }),
  )

  const step = (delta: number) => {
    const n = count()
    if (n < 2) return
    const next = siblings()[(index() + delta + n) % n]
    if (next !== undefined) setCurrent(next)
  }

  /** The scale that fits the (rotated) picture into the stage. */
  const fitScale = createMemo(() => {
    const nat = natural()
    if (nat === null || stage === undefined) return 1
    const rotated = rotation() % 180 !== 0
    const w = rotated ? nat.h : nat.w
    const h = rotated ? nat.w : nat.h
    const pad = 2 * 16
    const sw = Math.max(1, stage.clientWidth - pad)
    const sh = Math.max(1, stage.clientHeight - pad)
    return Math.min(1, sw / w, sh / h)
  })
  const [stageSize, setStageSize] = createSignal(0)
  const effectiveScale = () => {
    void stageSize()
    return fit() ? fitScale() : zoom()
  }

  const setScaleAt = (next: number, cx?: number, cy?: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
    const before = effectiveScale()
    if (cx !== undefined && cy !== undefined && stage !== undefined) {
      // keep the point under the cursor still
      const r = stage.getBoundingClientRect()
      const ox = cx - r.left - r.width / 2 - pan().x
      const oy = cy - r.top - r.height / 2 - pan().y
      const k = clamped / before
      setPan({ x: pan().x - ox * (k - 1), y: pan().y - oy * (k - 1) })
    }
    setFit(false)
    setZoom(clamped)
  }
  const zoomBy = (delta: 1 | -1, cx?: number, cy?: number) =>
    setScaleAt(zoomStep(effectiveScale(), delta), cx, cy)
  const toFit = () => {
    setFit(true)
    setPan({ x: 0, y: 0 })
  }
  const toActual = () => {
    setFit(false)
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const transform = () =>
    `translate(${pan().x}px, ${pan().y}px) scale(${effectiveScale()}) rotate(${rotation()}deg) scale(${flipH() ? -1 : 1}, ${flipV() ? -1 : 1})`

  // slideshow
  createEffect(() => {
    if (!slideshow() || !props.active) return
    const t = setInterval(() => step(1), slideSeconds() * 1000)
    onCleanup(() => clearInterval(t))
  })

  // stage size → refit; WebKit's pinch gestures (not in Solid's typed events)
  createEffect(() => {
    if (stage === undefined) return
    const el = stage
    const ro = new ResizeObserver(() => setStageSize((n) => n + 1))
    ro.observe(el)
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    onCleanup(() => {
      ro.disconnect()
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
    })
  })

  // wheel: zoom (plain wheel too — it is a picture viewer), pinch via gesture events
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    if (e.shiftKey && !e.ctrlKey) {
      step(e.deltaY > 0 ? 1 : -1)
      return
    }
    zoomBy(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY)
  }
  let gestureBase = 1
  const onGestureStart = (e: Event) => {
    e.preventDefault()
    gestureBase = effectiveScale()
  }
  const onGestureChange = (e: Event) => {
    e.preventDefault()
    const g = (e as Event & { scale?: number; clientX?: number; clientY?: number }).scale
    if (g !== undefined) setScaleAt(gestureBase * g)
  }

  // drag to pan (pointer events; also two-finger drag on a touchpad is a wheel without ctrl… we zoom)
  let drag: { x: number; y: number; px: number; py: number } | null = null
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    drag = { x: e.clientX, y: e.clientY, px: pan().x, py: pan().y }
    setDragging(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent) => {
    if (drag === null) return
    setPan({ x: drag.px + (e.clientX - drag.x), y: drag.py + (e.clientY - drag.y) })
  }
  const onPointerUp = (e: PointerEvent) => {
    if (drag === null) return
    const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4
    drag = null
    setDragging(false)
    if (!moved && e.target === img) {
      // click toggles fit / actual like the browser's viewer
      if (fit()) setScaleAt(1, e.clientX, e.clientY)
      else toFit()
    }
  }

  const doTrash = async () => {
    const path = current()
    try {
      await trashFile(path)
      toast(`Moved ${baseName(path)} to the Trash`, { kind: 'success' })
      const rest = siblings().filter((p) => p !== path)
      if (rest.length === 0) props.onClose?.()
      else {
        const nextIndex = Math.min(index(), rest.length - 1)
        setSiblings(rest)
        setCurrent(rest[nextIndex] ?? rest[0] ?? path)
      }
    } catch (e) {
      toast(`Could not move it to the Trash: ${e instanceof Error ? e.message : String(e)}`, {
        kind: 'danger',
      })
    }
  }

  const doCopy = async () => {
    try {
      await copyImage(current(), mime()?.type ?? 'image/png')
      toast('Picture copied', { kind: 'success' })
    } catch (e) {
      toast(`Could not copy: ${e instanceof Error ? e.message : String(e)}`, { kind: 'danger' })
    }
  }

  const doWallpaper = async () => {
    try {
      await setWallpaper(current())
      toast('Set as the wallpaper', { kind: 'success' })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { kind: 'danger' })
    }
  }

  const showOpenWith = async () => {
    const type = mime()?.type ?? 'image/png'
    const apps = await invoke<AppInfo[]>('apps_for', { contentType: type, all: false }).catch(
      (): AppInfo[] => [],
    )
    setOpenWith(apps)
  }

  const launch = async (app: AppInfo | null) => {
    try {
      await invoke<null>('launch_with', { desktopId: app?.id ?? null, paths: [current()] })
      setOpenWith(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { kind: 'danger' })
    }
  }

  useKeys(
    () => props.active,
    (e) => {
      if (confirmTrash() || openWith() !== null) return false
      if (isMod(e)) {
        switch (e.key) {
          case '=':
          case '+':
            zoomBy(1)
            return true
          case '-':
            zoomBy(-1)
            return true
          case '0':
            toFit()
            return true
          case '1':
            toActual()
            return true
          case 'c':
            void doCopy()
            return true
          case 'i':
            toggleInfo()
            return true
          default:
            return false
        }
      }
      if (inTextInput(e)) return false
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case 'n':
        case 'j':
        case ' ':
          step(1)
          return true
        case 'ArrowLeft':
        case 'PageUp':
        case 'p':
        case 'k':
        case 'Backspace':
          step(-1)
          return true
        case 'Home':
          setCurrent(siblings()[0] ?? current())
          return true
        case 'End':
          setCurrent(siblings()[count() - 1] ?? current())
          return true
        case '+':
        case '=':
          zoomBy(1)
          return true
        case '-':
          zoomBy(-1)
          return true
        case 'f':
        case '0':
          toFit()
          return true
        case '1':
          toActual()
          return true
        case 'r':
          setRotation((r) => (r + (e.shiftKey ? 270 : 90)) % 360)
          return true
        case 'h':
          setFlipH((v) => !v)
          return true
        case 'v':
          setFlipV((v) => !v)
          return true
        case 'i':
          toggleInfo()
          return true
        case 's':
          setSlideshow((v) => !v)
          return true
        case 'Delete':
          setConfirmTrash(true)
          return true
        case 'Escape':
          if (slideshow()) {
            setSlideshow(false)
            return true
          }
          return false
        default:
          return false
      }
    },
  )

  const toggleInfo = () => {
    setInfo((v) => {
      setSetting('imageInfo', !v)
      return !v
    })
  }

  const moreItems = (): MenuEntry[] => [
    {
      type: 'item',
      id: 'copy',
      label: 'Copy picture',
      icon: 'copy',
      hint: 'Ctrl+C',
      run: () => void doCopy(),
    },
    {
      type: 'item',
      id: 'wall',
      label: 'Set as wallpaper',
      icon: 'wallpaper',
      run: () => void doWallpaper(),
    },
    {
      type: 'item',
      id: 'open-with',
      label: 'Open with…',
      icon: 'external-link',
      run: () => void showOpenWith(),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'flip-h',
      label: 'Flip left–right',
      icon: 'flip-horizontal',
      hint: 'H',
      run: () => setFlipH((v) => !v),
    },
    {
      type: 'item',
      id: 'flip-v',
      label: 'Flip top–bottom',
      icon: 'flip-vertical',
      hint: 'V',
      run: () => setFlipV((v) => !v),
    },
    {
      type: 'item',
      id: 'checker',
      label: checker() ? 'Plain background' : 'Checkered background',
      icon: 'layout-grid',
      run: () =>
        setChecker((v) => {
          setSetting('imageChecker', !v)
          return !v
        }),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'slide-speed',
      label: 'Slideshow speed',
      icon: 'play',
      items: [2, 4, 6, 10, 20].map((s): MenuEntry => ({
        type: 'item',
        id: `s${s}`,
        label: `${s} seconds`,
        dot: slideSeconds() === s ? 'var(--accent)' : undefined,
        run: () => {
          setSlideSeconds(s)
          setSetting('slideSeconds', s)
        },
      })),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'trash',
      label: 'Move to Trash',
      icon: 'trash-2',
      hint: 'Delete',
      danger: true,
      run: () => setConfirmTrash(true),
    },
  ]

  const metaLine = () => {
    const parts: string[] = []
    if (count() > 1) parts.push(`${index() + 1} of ${count()}`)
    const st = details()?.stat
    if (st !== undefined) parts.push(formatBytes(st.size))
    const n = natural()
    if (n !== null) parts.push(`${n.w} × ${n.h}`)
    return parts.join(' · ')
  }

  const dimensionRow = () => {
    const n = natural()
    return n === null
      ? null
      : `${n.w} × ${n.h} pixels${n.w * n.h >= 1_000_000 ? ` (${(Math.round((n.w * n.h) / 100_000) / 10).toString()} MP)` : ''}`
  }

  return (
    <div class="iv" classList={{ 'iv--slideshow': slideshow() }}>
      <Toolbar label="Picture" class="view-toolbar">
        <span class="view-title">
          <span class="view-name" dir="auto">
            {name()}
          </span>
          <span class="view-meta">{metaLine()}</span>
        </span>
        <span class="toolbar-spacer" />
        <IconButton
          icon="chevron-left"
          label="Previous picture (←)"
          disabled={count() < 2}
          onClick={() => step(-1)}
        />
        <IconButton
          icon="chevron-right"
          label="Next picture (→)"
          disabled={count() < 2}
          onClick={() => step(1)}
        />
        <span class="toolbar-divider" />
        <IconButton icon="zoom-out" label="Zoom out (−)" onClick={() => zoomBy(-1)} />
        <button
          type="button"
          class="btn btn--ghost btn--sm iv-zoom"
          aria-label="Zoom"
          onClick={() => (fit() ? toActual() : toFit())}
          data-tooltip={fit() ? 'Actual size (1)' : 'Fit (F)'}
        >
          {fit() ? `Fit · ${percent(effectiveScale())}` : percent(effectiveScale())}
        </button>
        <IconButton icon="zoom-in" label="Zoom in (+)" onClick={() => zoomBy(1)} />
        <IconButton icon="scan" label="Fit to window (F)" active={fit()} onClick={toFit} />
        <span class="toolbar-divider" />
        <IconButton
          icon="rotate-cw"
          label="Rotate (R)"
          onClick={() => setRotation((r) => (r + 90) % 360)}
        />
        <IconButton
          icon={slideshow() ? 'pause' : 'play'}
          label={slideshow() ? 'Stop the slideshow (S)' : 'Slideshow (S)'}
          active={slideshow()}
          disabled={count() < 2}
          onClick={() => setSlideshow((v) => !v)}
        />
        <IconButton icon="info" label="Info (I)" active={info()} onClick={toggleInfo} />
        <IconButton
          icon="ellipsis"
          label="More"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setMenuAt({ x: r.right, y: r.bottom + 4 })
          }}
        />
      </Toolbar>
      <div class="iv-body">
        <div
          ref={stage}
          class="iv-stage"
          classList={{
            'iv-stage--checker': checker(),
            'iv-stage--drag': dragging(),
            'iv-stage--zoomed': !fit(),
          }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDblClick={(e) => {
            e.preventDefault()
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenuAt({ x: e.clientX, y: e.clientY })
          }}
        >
          <Show
            when={!failed()}
            fallback={
              <EmptyState icon="image" title="This picture cannot be shown here" warning>
                {mime()?.type.includes('hei') === true
                  ? 'This phone picture could not be converted: libheif (heif-dec) may be missing.'
                  : `The system's WebKit cannot decode this ${mime()?.description ?? 'picture'}.`}{' '}
                <Button small kind="secondary" onClick={() => void showOpenWith()}>
                  Open with…
                </Button>
              </EmptyState>
            }
          >
            <img
              ref={img}
              class="iv-image"
              src={pictureUrl(props.server, current())}
              alt={name()}
              draggable={false}
              style={{ transform: transform() }}
              onLoad={(e) => {
                setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
                const z = flagNumber(flags(), 'zoom')
                if (z !== null && z > 0 && current() === props.path) setScaleAt(z / 100)
              }}
              onError={() => setFailed(true)}
            />
          </Show>
          <Show when={count() > 1 && !slideshow()}>
            <button class="iv-nav prev" aria-label="Previous" onClick={() => step(-1)}>
              <span class="iv-nav-glyph">‹</span>
            </button>
            <button class="iv-nav next" aria-label="Next" onClick={() => step(1)}>
              <span class="iv-nav-glyph">›</span>
            </button>
          </Show>
        </div>
        <Show when={info()}>
          <aside class="iv-info" aria-label="Picture info">
            <h2 class="iv-info-title">{name()}</h2>
            <dl class="info-rows">
              <dt>Folder</dt>
              <dd class="info-path">{dirName(current())}</dd>
              <Show when={details()?.stat}>
                {(s) => (
                  <>
                    <dt>Size</dt>
                    <dd>{formatBytes(s().size)}</dd>
                    <dt>Changed</dt>
                    <dd>
                      {new Date(s().modified).toLocaleString(undefined, {
                        dateStyle: 'long',
                        timeStyle: 'short',
                      })}
                    </dd>
                  </>
                )}
              </Show>
              <Show when={mime()}>
                {(m) => (
                  <>
                    <dt>Type</dt>
                    <dd>{m().description}</dd>
                  </>
                )}
              </Show>
              <Show when={dimensionRow()}>
                {(d) => (
                  <>
                    <dt>Dimensions</dt>
                    <dd>{d()}</dd>
                  </>
                )}
              </Show>
              <For each={exifRows(details()?.exif ?? null)}>
                {(row) => (
                  <>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </>
                )}
              </For>
            </dl>
            <Show when={details() !== undefined && details()?.exif === null}>
              <p class="iv-info-note">No camera data in this picture.</p>
            </Show>
            <div class="iv-info-row">
              <Toggle
                checked={checker()}
                label="Checkered background"
                onChange={(v) => {
                  setChecker(v)
                  setSetting('imageChecker', v)
                }}
              />
              <span>Checkered background</span>
            </div>
          </aside>
        </Show>
      </div>
      <Show when={menuAt()}>
        {(at) => <Menu items={moreItems()} at={at()} onClose={() => setMenuAt(null)} />}
      </Show>
      <Dialog
        open={confirmTrash()}
        title={`Move ${name()} to the Trash?`}
        description="You can bring it back from the Trash in ewe Files."
        onClose={() => setConfirmTrash(false)}
        actions={
          <>
            <Button kind="ghost" onClick={() => setConfirmTrash(false)}>
              Cancel
            </Button>
            <Button
              kind="primary"
              onClick={() => {
                setConfirmTrash(false)
                void doTrash()
              }}
            >
              Move to Trash
            </Button>
          </>
        }
      />
      <Dialog
        open={openWith() !== null}
        title="Open with"
        description={name()}
        onClose={() => setOpenWith(null)}
      >
        <Show
          when={(openWith() ?? []).length > 0}
          fallback={<p class="dialog-desc">No other app on this machine opens this type.</p>}
        >
          <ul class="app-list">
            <For each={openWith() ?? []}>
              {(app) => (
                <li>
                  <button type="button" class="app-list-row" onClick={() => void launch(app)}>
                    <span class="app-list-name">{app.name}</span>
                    <Show when={app.default}>
                      <span class="app-list-hint">Default</span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Dialog>
    </div>
  )
}
