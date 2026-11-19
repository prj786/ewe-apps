// A clear page for what ewe Viewer cannot show itself (ODT, PPTX, DOC, RTF…): the type,
// the size, and the apps GIO knows for it — LibreOffice is in the list when installed.

import { For, Show, createResource, type JSX } from 'solid-js'
import { invoke } from '@tauri-apps/api/core'
import { formatBytes, type AppInfo, type MimeInfo } from '@ewe/shared'
import { Button, EmptyState, Icon, toast } from '@ewe/ui'
import { fileStat } from '../lib/bridge'
import { baseName } from '../lib/kinds'
import type { ViewProps } from './types'

export function OtherView(props: ViewProps): JSX.Element {
  const [info] = createResource(
    () => props.path,
    async (path) => {
      const [mime, stat] = await Promise.all([
        invoke<MimeInfo>('mime_of', { path }),
        fileStat(path).catch(() => null),
      ])
      const apps = await invoke<AppInfo[]>('apps_for', {
        contentType: mime.type,
        all: false,
      }).catch((): AppInfo[] => [])
      return { mime, stat, apps }
    },
  )

  const launch = async (app: AppInfo | null) => {
    try {
      await invoke<null>('launch_with', { desktopId: app?.id ?? null, paths: [props.path] })
      toast(`Opening in ${app?.name ?? 'the default app'}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { kind: 'danger' })
    }
  }

  return (
    <div class="view-center ov">
      <Show
        when={info()}
        fallback={<EmptyState icon="file-question" title={baseName(props.path)} compact />}
      >
        {(i) => (
          <>
            <EmptyState icon="file-question" title={baseName(props.path)} heading="h2">
              {i().mime.description}
              {i().stat === null ? '' : ` · ${formatBytes(i().stat?.size ?? 0)}`}. ewe Viewer cannot
              show this kind of file itself.
            </EmptyState>
            <Show
              when={i().apps.length > 0}
              fallback={
                <p class="ov-note">
                  No installed app opens this type. LibreOffice from Komble opens Office documents.
                </p>
              }
            >
              <div class="ov-apps">
                <span class="ov-apps-title">Open with</span>
                <ul class="app-list">
                  <For each={i().apps}>
                    {(app) => (
                      <li>
                        <button type="button" class="app-list-row" onClick={() => void launch(app)}>
                          <Icon name="external-link" />
                          <span class="app-list-name">{app.name}</span>
                          <Show when={app.default}>
                            <span class="app-list-hint">Default</span>
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <Button kind="primary" icon="external-link" onClick={() => void launch(null)}>
                  Open with the default app
                </Button>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
