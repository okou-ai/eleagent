// Streaming zh/en ASR with the sherpa-onnx WASM build, entirely in the page.
// Classic script: the Emscripten loader reads the global Module defined here.
(() => {
  const SAMPLE_RATE = 16000;
  const MAX_UTTERANCE_SECONDS = 30;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const state = {
    status: 'loading model', recognizer: null, stream: null, finals: [], partial: '', decodeMs: 0, audioMs: 0,
    onText: () => {}, onUtterance: () => {},
  };
  let chunks = [], samples = 0, nextId = 1;

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

  function downsample(input, fromRate) {
    if (fromRate === SAMPLE_RATE) return input;
    const ratio = fromRate / SAMPLE_RATE;
    const out = new Float32Array(Math.round(input.length / ratio));
    for (let i = 0, offset = 0; i < out.length; i++) {
      const next = Math.round((i + 1) * ratio);
      let sum = 0, count = 0;
      for (; offset < next && offset < input.length; offset++) { sum += input[offset]; count++; }
      out[i] = count ? sum / count : 0;
    }
    return out;
  }

  // Audio of the current utterance, kept for the on-device speaker embedding.
  function remember(pcm) {
    chunks.push(pcm);
    samples += pcm.length;
    while (samples > MAX_UTTERANCE_SECONDS * SAMPLE_RATE && chunks.length > 1) samples -= chunks.shift().length;
  }
  function takeUtterance() {
    const pcm = new Float32Array(samples);
    let offset = 0;
    for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
    chunks = []; samples = 0;
    return pcm;
  }

  function feed(input, rate) {
    const { recognizer, stream } = state;
    if (!recognizer) return;
    const started = performance.now();
    const pcm = downsample(input, rate);
    remember(pcm);
    stream.acceptWaveform(SAMPLE_RATE, pcm);
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = recognizer.getResult(stream).text;
    if (recognizer.isEndpoint(stream)) {
      const utterance = takeUtterance();
      if (text) {
        const final = { id: nextId++, text, speaker: null };
        state.finals = [...state.finals, final].slice(-3);
        state.onUtterance(final, utterance);
      }
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

  function setSpeaker(id, speaker) {
    const final = state.finals.find(item => item.id === id);
    if (!final) return;
    final.speaker = speaker;
    state.onText(state.finals, state.partial);
  }

  window.liveAsr = {
    ready,
    state,
    feed,
    setSpeaker,
    rtf: () => state.audioMs ? state.decodeMs / state.audioMs : 0,
  };
})();
