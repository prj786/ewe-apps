// The search bar (Ctrl+Shift+F): a query, filters, "Search everywhere" with plocate.

import { createSignal, type JSX } from 'solid-js'
import type { SearchFilters } from '@ewe/shared'
import { Button, Field, IconButton, Segmented, Switch } from '@ewe/ui'

const KINDS: { value: SearchFilters['kind']; label: string }[] = [
  { value: '', label: 'Anything' },
  { value: 'folder', label: 'Folders' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'audio', label: 'Audio' },
  { value: 'document', label: 'Documents' },
  { value: 'archive', label: 'Archives' },
  { value: 'code', label: 'Code' },
]

export function SearchBar(props: {
  plocate: boolean
  where: string
  onSearch(filters: SearchFilters, everywhere: boolean): void
  onClose(): void
}): JSX.Element {
  const [query, setQuery] = createSignal('')
  const [kind, setKind] = createSignal<SearchFilters['kind']>('')
  const [days, setDays] = createSignal('0')
  const [size, setSize] = createSignal('0')
  const [hidden, setHidden] = createSignal(false)
  const [everywhere, setEverywhere] = createSignal(false)
  const run = () => {
    const q = query().trim()
    if (q === '' && kind() === '' && days() === '0' && size() === '0') return
    const [minSize, maxSize] =
      size() === 'big'
        ? [100 * 1024 * 1024, 0]
        : size() === 'medium'
          ? [1024 * 1024, 100 * 1024 * 1024]
          : size() === 'small'
            ? [0, 1024 * 1024]
            : [0, 0]
    props.onSearch(
      { query: q, kind: kind(), days: Number(days()), minSize, maxSize, hidden: hidden() },
      everywhere(),
    )
  }
  return (
    <div class="fm-search" role="search">
      <div class="fm-search-row">
        <Field
          value={query()}
          label="Search"
          placeholder={
            everywhere() ? 'Search everywhere' : `Search in ${props.where} and its folders`
          }
          icon="search"
          clearable
          autofocus
          class="fm-search-field"
          onInput={setQuery}
          onSubmit={run}
          onCancel={() => props.onClose()}
        />
        <Button kind="primary" onClick={run}>
          Search
        </Button>
        <IconButton icon="x" label="Close search" onClick={() => props.onClose()} />
      </div>
      <div class="fm-search-row filters">
        <Segmented
          small
          value={kind()}
          label="Kind"
          options={KINDS}
          onChange={(v) => setKind(v as SearchFilters['kind'])}
        />
        <Segmented
          small
          value={days()}
          label="Modified"
          options={[
            { value: '0', label: 'Any time' },
            { value: '1', label: 'Today' },
            { value: '7', label: 'This week' },
            { value: '30', label: 'This month' },
            { value: '365', label: 'This year' },
          ]}
          onChange={setDays}
        />
        <Segmented
          small
          value={size()}
          label="Size"
          options={[
            { value: '0', label: 'Any size' },
            { value: 'small', label: 'Under 1 MB' },
            { value: 'medium', label: '1–100 MB' },
            { value: 'big', label: 'Over 100 MB' },
          ]}
          onChange={setSize}
        />
        <label class="row-switch">
          <Switch checked={hidden()} label="Hidden files too" onChange={setHidden} />
          <span>Hidden files too</span>
        </label>
        <label
          class="row-switch"
          title={
            props.plocate ? 'Uses plocate: the whole machine, fast' : 'plocate is not installed'
          }
        >
          <Switch
            checked={everywhere()}
            label="Search everywhere"
            disabled={!props.plocate}
            onChange={setEverywhere}
          />
          <span>Search everywhere</span>
        </label>
      </div>
    </div>
  )
}
