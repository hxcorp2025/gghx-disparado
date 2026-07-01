// Skeleton loading (shimmer) — usa a classe .skel do design system.

export function SkeletonList({ rows = 5, height = 46 }: { rows?: number; height?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel" style={{ height, borderRadius: 11 }} />
      ))}
    </div>
  )
}

export function SkeletonCards({ n = 4 }: { n?: number }) {
  return (
    <div className="statcards">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="skel" style={{ height: 92, minWidth: 148, flex: 1 }} />
      ))}
    </div>
  )
}
