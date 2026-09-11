class InterviewMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.samples = [];
    this.sum = 0;
    this.count = 0;
    this.activitySum = 0;
    this.activityCount = 0;
    this.voicedMs = 0;
    this.noise = 0.003;
    this.muted = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === "mute") {
        if (data.value && this.samples.length) this.frame(true);
        this.muted = data.value;
        this.samples = [];
        this.sum = 0;
        this.count = 0;
        this.voicedMs = 0;
        this.port.postMessage({ type: "mute_ack", id: data.id });
      }
    };
  }
  frame(final = false) {
    const pcm = new Int16Array(this.samples.splice(0, 3200));
    if (pcm.length)
      this.port.postMessage(
        {
          type: "frame",
          pcm: pcm.buffer,
          level: Math.sqrt(this.sum / Math.max(1, this.count)),
          final,
        },
        [pcm.buffer],
      );
    this.sum = 0;
    this.count = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || this.muted) return true;
    const step = sampleRate / 16000;
    for (const value of input) {
      this.sum += value * value;
      this.count++;
      this.activitySum += value * value;
      this.activityCount++;
      if (this.activityCount >= sampleRate * 0.02) {
        const level = Math.sqrt(this.activitySum / this.activityCount),
          voiced = level > Math.max(0.012, this.noise * 3);
        if (!voiced) this.noise = 0.98 * this.noise + 0.02 * level;
        this.voicedMs = voiced ? this.voicedMs + 20 : 0;
        this.port.postMessage({
          type: "activity",
          level,
          voiced: this.voicedMs >= 80,
        });
        this.activitySum = 0;
        this.activityCount = 0;
      }
    }
    while (this.phase < input.length) {
      const a = Math.floor(this.phase),
        b = Math.min(a + 1, input.length - 1),
        f = this.phase - a;
      this.samples.push(
        Math.round(
          Math.max(-1, Math.min(1, input[a] * (1 - f) + input[b] * f)) * 32767,
        ),
      );
      this.phase += step;
    }
    this.phase -= input.length;
    if (this.samples.length >= 3200) this.frame();
    return true;
  }
}
registerProcessor("interview-mic", InterviewMic);
