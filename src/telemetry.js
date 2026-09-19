export function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export function makeTimelineEvent(type, label, data = {}) {
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    monoMs: nowMs(),
    type,
    label,
    data,
  };
}
