// Hands the microphone's samples (mono, the context's rate) to the page in batches of about 100 ms.
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(Math.round(sampleRate / 10));
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.batch[this.filled++] = channel[i];
        if (this.filled === this.batch.length) {
          this.port.postMessage(this.batch.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('eleagent-tap', Tap);
