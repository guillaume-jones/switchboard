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
    <div style={{ padding: 8 }}>
      {streams.length === 0 && <div style={{ color: 'var(--muted)' }}>No workstreams yet</div>}
      {streams.map(stream => (
        <div key={stream.id} style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600 }}>
            {stream.title} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>{stream.state}</span>
          </div>
          {membersByStream.get(stream.id)?.map(member => (
            <div key={member.ref} style={{ paddingLeft: 12 }}>
              <Item ref={member.ref} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
