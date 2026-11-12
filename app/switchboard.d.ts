// Written by the app on start. Cards import from "switchboard"; react and react/jsx-runtime are also provided.
declare module 'switchboard' {
  import type { ReactElement, ReactNode } from 'react'

  export type Row = Record<string, any>
  export type Params = Record<string, unknown>
  export type Size = 'compact' | 'full'
  export type CardProps<P = {}> = P & { size: Size; slot?: string }

  /** View (`prs_items`, params are equality filters) or query (`prs.search`). Live; undefined until loaded; throws on error. */
  export function useQuery<T extends Row = Row>(name: string, params?: Params): T[] | undefined
  /** Calls a writer (`prs.dismiss`); resolves to the number of changed rows, rejects with an Error. */
  export function mutate(name: string, params?: Params): Promise<number>
  /** Starts a command (`prs.fix-ci`); resolves to the run id, rejects with an Error. */
  export function run(name: string, args?: Params): Promise<string>
  /** Sets this card's context variables, read by key bindings (`{selected}`). null or undefined means missing. */
  export function useExpose(vars: Record<string, unknown>): void
  /** The only way to render another card. `id` keys per-slot state such as grid geometry; the card receives it as `slot`. */
  export function CardSlot(props: { component: string; props?: Params; size?: Size; id?: string }): ReactNode
  /** Renders a ref (`prs:4812`) with its source's item_card (which receives `ref` and `size`), else the raw ref. */
  export function Item(props: { ref: string; size?: Size }): ReactElement
}
