export function VoiceOrb({
  state = "idle",
  level = 0,
}: {
  state?: string;
  level?: number;
}) {
  return (
    <div className="orb-wrap" aria-hidden="true">
      <div
        className="orb"
        data-state={state}
        style={
          level > 0.02
            ? { transform: `scale(${1 + Math.min(level, 0.15)})` }
            : undefined
        }
      >
        <div className="bars">
          {[0, 1, 2, 3, 4].map((n) => (
            <i key={n} />
          ))}
        </div>
      </div>
    </div>
  );
}
