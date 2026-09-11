export type Capture = {
  context: AudioContext;
  stream: MediaStream;
  stop: () => void;
  mute: (value: boolean) => Promise<void>;
};
export async function capture(
  onFrame: (pcm: ArrayBuffer, level: number, final?: boolean) => void,
  onLost: () => void,
  onActivity?: (level: number, voiced: boolean) => void,
): Promise<Capture> {
  const context = new AudioContext();
  await context.resume();
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    await context.audioWorklet.addModule("/mic-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "interview-mic");
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(worklet);
    worklet.connect(sink).connect(context.destination);
    const acknowledgments = new Map<string, () => void>();
    worklet.port.onmessage = ({ data }) => {
      if (data.type === "activity") onActivity?.(data.level, data.voiced);
      else if (data.type === "mute_ack") {
        acknowledgments.get(data.id)?.();
        acknowledgments.delete(data.id);
      } else onFrame(data.pcm, data.level, data.final);
    };
    stream.getTracks().forEach((t) => t.addEventListener("ended", onLost));
    let stopped = false;
    const state = () => {
      if (!stopped && context.state === "suspended") onLost();
    };
    context.addEventListener("statechange", state);
    return {
      context,
      stream,
      mute: async (value) => {
        const id = crypto.randomUUID();
        if (!value) stream!.getAudioTracks().forEach((t) => (t.enabled = true));
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            acknowledgments.delete(id);
            reject(new Error("麦克风状态确认超时"));
          }, 1000);
          acknowledgments.set(id, () => {
            clearTimeout(timer);
            resolve();
          });
          worklet.port.postMessage({ type: "mute", value, id });
        });
        if (value) stream!.getAudioTracks().forEach((t) => (t.enabled = false));
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        for (const resolve of acknowledgments.values()) resolve();
        acknowledgments.clear();
        worklet.port.onmessage = null;
        worklet.disconnect();
        source.disconnect();
        sink.disconnect();
        stream!.getTracks().forEach((t) => {
          t.removeEventListener("ended", onLost);
          t.stop();
        });
        context.removeEventListener("statechange", state);
        void context.close();
      },
    };
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop());
    void context.close();
    throw e;
  }
}
export function base64(buffer: ArrayBuffer) {
  let result = "";
  for (const n of new Uint8Array(buffer)) result += String.fromCharCode(n);
  return btoa(result);
}
export function pcmBuffer(
  context: AudioContext,
  encoded: string,
  rate: number,
) {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const samples = new DataView(bytes.buffer);
  const audio = context.createBuffer(1, bytes.length / 2, rate);
  const channel = audio.getChannelData(0);
  for (let i = 0; i < channel.length; i++)
    channel[i] = samples.getInt16(i * 2, true) / 32768;
  return audio;
}
