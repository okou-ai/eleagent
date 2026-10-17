// Streaming zh/en ASR with the sherpa-onnx WASM build, entirely in the page.
// Classic script: the Emscripten loader reads the global Module defined here.
(() => {
  const SAMPLE_RATE = 16000;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const state = { status: 'loading model', recognizer: null, stream: null, finals: [], partial: '', decodeMs: 0, audioMs: 0, onText: () => {} };

  window.Module = {
    locateFile: path => `/live/assets/asr/${path}`,
    setStatus(status) {
      const match = status.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/);
      if (match) state.status = `downloading ${Math.round(Number(match[1]) / Number(match[2]) * 100)}%`;
    },
    onRuntimeInitialized() {
      const started = performance.now();
      // eslint-disable-next-line no-undef
      state.recognizer = createOnlineRecognizer(window.Module);
      state.stream = state.recognizer.createStream();
      state.status = `ready (${Math.round(performance.now() - started)} ms init)`;
      resolveReady();
    },
  };

  function downsample(samples, fromRate) {
    if (fromRate === SAMPLE_RATE) return samples;
    const ratio = fromRate / SAMPLE_RATE;
    const out = new Float32Array(Math.round(samples.length / ratio));
    for (let i = 0, offset = 0; i < out.length; i++) {
      const next = Math.round((i + 1) * ratio);
      let sum = 0, count = 0;
      for (; offset < next && offset < samples.length; offset++) { sum += samples[offset]; count++; }
      out[i] = count ? sum / count : 0;
    }
    return out;
  }

  function feed(samples, rate) {
    const { recognizer, stream } = state;
    if (!recognizer) return;
    const started = performance.now();
    const pcm = downsample(samples, rate);
    stream.acceptWaveform(SAMPLE_RATE, pcm);
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = recognizer.getResult(stream).text;
    if (recognizer.isEndpoint(stream)) {
      if (text) state.finals = [...state.finals, text].slice(-2);
      state.partial = '';
      recognizer.reset(stream);
    } else {
      state.partial = text;
    }
    // Real-time factor: decoding time over audio duration.
    state.decodeMs += performance.now() - started;
    state.audioMs += pcm.length / SAMPLE_RATE * 1000;
    state.onText(state.finals, state.partial);
  }

  window.liveAsr = {
    ready,
    state,
    feed,
    rtf: () => state.audioMs ? state.decodeMs / state.audioMs : 0,
  };
})();
