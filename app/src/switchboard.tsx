// The `switchboard` module cards import. Every export here is visible to cards; switchboard.d.ts is its declared contract.
import {
  createContext,
  memo,
  Suspense,
  use,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type SyntheticEvent,
} from 'react'
import { Boundary } from './boundary'
import * as bridge from './bridge'
import type { Params, Row, Size } from './bridge'
import { loadCard, watchCards, type CardComponent } from './cards'
import { useLoadedConfig } from './config'
import { claimFocus, mountSlot, type SlotFrame } from './focus'
import { subscription } from './subscriptions'

export function useQuery<T extends Row = Row>(name: string, params?: Params): T[] | undefined {
  const query = subscription(name, params)
  const rows = useSyncExternalStore(query.subscribe, query.getSnapshot)
  if (query.error) throw query.error
  return rows as T[] | undefined
}

export const mutate = (name: string, params: Params = {}) => bridge.mutate(name, params).then(r => r.changes)

export const run = (name: string, args: Params = {}) => bridge.run(name, args).then(r => r.run_id)

export const useCards = () => useLoadedConfig().cards

const FrameContext = createContext<SlotFrame | null>(null)

export function useExpose(vars: Record<string, unknown>) {
  const frame = useContext(FrameContext)
  useLayoutEffect(() => {
    if (!frame) return
    Object.assign(frame.vars, vars)
    return () => {
      for (const name in vars) delete frame.vars[name]
    }
  })
}

type SlotProps = { component: string; props?: Params; size?: Size; id?: string }

export const CardSlot = memo(function CardSlot({ component, props, size = 'full', id }: SlotProps) {
  const parent = useContext(FrameContext)
  const { depth_cap } = useLoadedConfig()
  const card = useSyncExternalStore(watchCards, () => loadCard(component))
  const [frame] = useState((): SlotFrame => ({
    card: component,
    size,
    vars: {},
    parent,
    depth: (parent?.depth ?? 0) + 1,
    el: null,
  }))
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    frame.card = component
    frame.size = size
  })
  useEffect(() => mountSlot(frame, el.current!), [frame])
  const claim = (e: SyntheticEvent) => claimFocus(frame, e.nativeEvent)
  return (
    <FrameContext value={frame}>
      <div className="slot" ref={el} onPointerDown={claim} onFocus={claim}>
        {frame.depth > depth_cap ? (
          <div className="card-error">
            {component}: nesting deeper than {depth_cap}
          </div>
        ) : (
          <Boundary key={card.generation} card={component} root={!parent}>
            <Suspense fallback={null}>
              <Card component={card.component} props={{ ...props, size, slot: id }} />
            </Suspense>
          </Boundary>
        )}
      </div>
    </FrameContext>
  )
})

function Card({ component, props }: { component: Promise<CardComponent>; props: Params }) {
  const Component = use(component)
  return <Component {...props} />
}

export function Item({ ref, size = 'compact' }: { ref: string; size?: Size }) {
  const { sources } = useLoadedConfig()
  const [source] = ref.split(':', 1)
  const itemCard = sources[source]?.item_card
  const props = useMemo(() => ({ ref }), [ref])
  return itemCard ? <CardSlot component={itemCard} props={props} size={size} /> : <span>{ref}</span>
}
