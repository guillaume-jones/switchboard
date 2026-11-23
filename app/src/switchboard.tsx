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
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { Boundary } from './boundary'
import * as bridge from './bridge'
import type { Params, Row, Size } from './bridge'
import { loadCard, watchCards, type CardComponent } from './cards'
import { useLoadedConfig } from './config'
import { claimFocus, mountSlot, releaseFocus, type SlotFrame } from './focus'
import type { ActionHandler } from './keymap'
import { subscription } from './subscriptions'
import { useRemoteStatus } from './remote'

export function useQuery<T extends Row = Row>(name: string, params?: Params): T[] | undefined {
  const query = subscription(name, params)
  const rows = useSyncExternalStore(query.subscribe, query.getSnapshot)
  if (query.error) throw query.error
  return rows as T[] | undefined
}

export const mutate = (name: string, params: Params = {}) => bridge.mutate(name, params).then(r => r.changes)

export const run = (name: string, args: Params = {}) => bridge.run(name, args).then(r => r.run_id)

export const pty = bridge.pty

export const microphone = bridge.microphone

export const useCards = () => useLoadedConfig().cards

export function useConnection() {
  const { connection, asOf } = useRemoteStatus()
  return { state: connection, asOf }
}

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

export function useActions(actions: Record<string, ActionHandler>) {
  const frame = useContext(FrameContext)
  useLayoutEffect(() => {
    if (!frame) return
    frame.actions ??= {}
    Object.assign(frame.actions, actions)
    return () => {
      for (const name in actions) if (frame.actions?.[name] === actions[name]) delete frame.actions[name]
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
    actions: {},
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

type RegionProps = {
  name: string
  vars?: Record<string, unknown>
  actions?: Record<string, ActionHandler>
  children: ReactNode
}

/** A part of a card that joins the context stack as `region:<name>` while focus is inside it. */
export function Region({ name, vars, actions, children }: RegionProps) {
  const parent = useContext(FrameContext)
  const [frame] = useState((): SlotFrame => ({
    card: name,
    size: parent?.size ?? 'full',
    vars: {},
    actions: {},
    region: true,
    parent,
    depth: parent?.depth ?? 0,
    el: null,
  }))
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    frame.card = name
    frame.size = parent?.size ?? 'full'
    Object.assign(frame.vars, vars)
    Object.assign(frame.actions!, actions)
    return () => {
      for (const key in vars) delete frame.vars[key]
      for (const key in actions) if (frame.actions?.[key] === actions[key]) delete frame.actions[key]
    }
  })
  useEffect(() => mountSlot(frame, el.current!), [frame])
  const claim = (e: SyntheticEvent) => claimFocus(frame, e.nativeEvent)
  return (
    <FrameContext value={frame}>
      <div
        className="region"
        ref={el}
        onPointerDown={claim}
        onFocus={claim}
        onBlur={e => !el.current?.contains(e.relatedTarget) && releaseFocus(frame)}
      >
        {children}
      </div>
    </FrameContext>
  )
}

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
