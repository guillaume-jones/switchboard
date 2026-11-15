import { useMemo } from 'react'
import { Item, useQuery } from 'switchboard'

type Stream = { id: string; title: string; state: string }
type Member = { stream_id: string; ref: string }

export default function Workstreams() {
  const streams = useQuery<Stream>('workstreams_items') ?? []
  const members = useQuery<Member>('workstreams_members')
  const membersByStream = useMemo(() => {
    const groups = new Map<string, Member[]>()
    for (const member of members ?? []) {
      const group = groups.get(member.stream_id)
      if (group) group.push(member)
      else groups.set(member.stream_id, [member])
    }
    return groups
  }, [members])

  return (
    <div style={{ padding: '8px 10px' }}>
      {streams.length === 0 && <div className="empty">No workstreams yet</div>}
      {streams.map(stream => (
        <div key={stream.id} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600, marginBottom: 4 }}>
            <span style={{ flex: 1, minWidth: 0 }}>{stream.title}</span>
            <span className="badge" data-tone={stream.state === 'active' ? 'good' : undefined}>
              {stream.state}
            </span>
          </div>
          {membersByStream.get(stream.id)?.map(member => (
            <div key={member.ref} style={{ padding: '3px 0 3px 10px', borderLeft: '2px solid var(--border)' }}>
              <Item ref={member.ref} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
