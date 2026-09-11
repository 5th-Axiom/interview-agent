import { DurableQueue } from "@/shared/voice-state";
type Pending = {
  text: DurableQueue<{ event_id: string; text: string }>;
  audio: Map<string, Record<string, any>>;
  played: Map<string, Record<string, any>>;
  inputs: Map<string, Record<string, any>>;
  frame: number;
  epoch: number;
};
const sessions = new Map<string, Pending>();
export function pendingVoice(id: string) {
  let pending = sessions.get(id);
  if (!pending) {
    for (const [key, value] of sessions)
      if (
        !value.text.size &&
        !value.audio.size &&
        !value.played.size &&
        !value.inputs.size
      )
        sessions.delete(key);
    if (sessions.size >= 10)
      throw new Error("还有待保存的面试，请先返回原面试完成保存");
    pending = {
      text: new DurableQueue(100),
      audio: new Map(),
      played: new Map(),
      inputs: new Map(),
      frame: 0,
      epoch: 0,
    };
    sessions.set(id, pending);
  }
  return pending;
}

export function hasPendingVoice(id: string) {
  const p = sessions.get(id);
  return (
    !!p &&
    (!!p.text.size || !!p.audio.size || !!p.played.size || !!p.inputs.size)
  );
}
