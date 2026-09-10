class InterviewMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.samples = [];
    this.sum = 0;
    this.count = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const step = sampleRate / 16000;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i] * input[i];
      this.count++;
    }
    while (this.phase < input.length) {
      const a = Math.floor(this.phase),
        b = Math.min(a + 1, input.length - 1),
        f = this.phase - a;
      const v = input[a] * (1 - f) + input[b] * f;
      this.samples.push(Math.round(Math.max(-1, Math.min(1, v)) * 32767));
      this.phase += step;
    }
    this.phase -= input.length;
    if (this.samples.length >= 3200) {
      const pcm = new Int16Array(this.samples.splice(0, 3200));
      this.port.postMessage(
        {
          pcm: pcm.buffer,
          level: Math.sqrt(this.sum / Math.max(1, this.count)),
        },
        [pcm.buffer],
      );
      this.sum = 0;
      this.count = 0;
    }
    return true;
  }
}
registerProcessor("interview-mic", InterviewMic);
