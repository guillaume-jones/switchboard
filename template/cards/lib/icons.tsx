import { OCTICONS, type Octicon } from './octicons'

export type IconName = Octicon

export const Icon = ({ name, size = 12 }: { name: IconName; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden
    style={{ flexShrink: 0, verticalAlign: '-0.125em' }}
    dangerouslySetInnerHTML={{ __html: OCTICONS[name] }}
  />
)

export function ArchiveIcon({ unarchive }: { unarchive: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1.5" y="2.5" width="13" height="3" rx="0.5" />
      <path d="M2.5 5.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-7" />
      <path d={unarchive ? 'M8 12V8M6 10l2-2 2 2' : 'M6.5 8.5h3'} />
    </svg>
  )
}

export function TerminalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6l2 2-2 2M8.5 10.5h3" />
    </svg>
  )
}

export function BellIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3ZM6.5 14a1.5 1.5 0 0 0 3 0" />
      {off && <path d="M2 2l12 12" />}
    </svg>
  )
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s' }}
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
  )
}
