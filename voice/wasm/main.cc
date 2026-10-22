// Eleagent's on-device voice module: the C API is the interface; this file only adds CopyHeap for the JS side.
#include <algorithm>
#include <cstdint>

#include "sherpa-onnx/c-api/c-api.h"

extern "C" {
void CopyHeap(const char *src, int32_t num_bytes, char *dst) {
  std::copy(src, src + num_bytes, dst);
}
}
