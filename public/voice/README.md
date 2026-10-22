# On-device voice (prototype)

A wake word and the owner's voiceprint, running in the browser. The capture page uses them for "Hey Okou"
(`public/capture/okou.js`); `/voice-lab` is for trying keywords and thresholds. Both keep the voiceprint samples in the
browser's localStorage, under the same key, and send no audio until a request is made.

- `eleagent-voice.js` / `eleagent-voice.wasm`: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) v1.13.8's C API for
  keyword spotting and speaker embeddings, compiled with Emscripten 4.0.23 by `voice/build-wasm.sh` (target in
  `voice/wasm/`). No models are packed in.
- `worklet.js`: an AudioWorklet that passes the microphone's samples to the page.
- `engine.js`: loads the module and the models (cached in the browser), and wraps the keyword spotter and the speaker
  embedding extractor. Its keyword-spotter config layout follows sherpa-onnx's `wasm/kws/sherpa-onnx-kws.js`.
- `models/kws/`: `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` (int8 encoder and joiner), a bilingual
  Chinese/English open-vocabulary keyword spotter: keywords are written as phones (ARPAbet or pinyin), no training.
- `models/speaker.onnx`: CAM++ from [3D-Speaker](https://github.com/modelscope/3D-Speaker)
  (`3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced`), fetched at build time by `scripts/fetch-voice-models.mjs`.

sherpa-onnx, its models and 3D-Speaker are Apache-2.0 licensed.
