# Eleagent's on-device voice: keyword spotting (wake word) and speaker embeddings (voiceprint) in one module.
# Models are not packed in; the page writes them into the in-memory filesystem at run time.
set(exported_functions
  SherpaOnnxCreateKeywordSpotter
  SherpaOnnxCreateKeywordStream
  SherpaOnnxDecodeKeywordStream
  SherpaOnnxDestroyKeywordResult
  SherpaOnnxDestroyKeywordSpotter
  SherpaOnnxDestroyOnlineStream
  SherpaOnnxGetKeywordResult
  SherpaOnnxIsKeywordStreamReady
  SherpaOnnxOnlineStreamAcceptWaveform
  SherpaOnnxOnlineStreamInputFinished
  SherpaOnnxResetKeywordStream
  SherpaOnnxCreateSpeakerEmbeddingExtractor
  SherpaOnnxDestroySpeakerEmbeddingExtractor
  SherpaOnnxSpeakerEmbeddingExtractorDim
  SherpaOnnxSpeakerEmbeddingExtractorCreateStream
  SherpaOnnxSpeakerEmbeddingExtractorIsReady
  SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding
  SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding
)
set(mangled_exported_functions)
foreach(x IN LISTS exported_functions)
  list(APPEND mangled_exported_functions "_${x}")
endforeach()
list(JOIN mangled_exported_functions "," all_exported_functions)

include_directories(${CMAKE_SOURCE_DIR})
set(MY_FLAGS "-s FORCE_FILESYSTEM=1 -s INITIAL_MEMORY=64MB -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=1GB")
string(APPEND MY_FLAGS " -sSTACK_SIZE=5242880 -sENVIRONMENT=web,worker -sMODULARIZE=1 -sEXPORT_NAME=createEleagentVoice ")
string(APPEND MY_FLAGS " -sEXPORTED_FUNCTIONS=[_CopyHeap,_malloc,_free,${all_exported_functions}] ")
string(APPEND MY_FLAGS " -sEXPORTED_RUNTIME_METHODS=['FS','ccall','stringToUTF8','setValue','getValue','lengthBytesUTF8','UTF8ToString','HEAPU8','HEAP32','HEAPF32'] ")

set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${MY_FLAGS}")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${MY_FLAGS}")
set(CMAKE_EXECUTABLE_LINKER_FLAGS "${CMAKE_EXECUTABLE_LINKER_FLAGS} ${MY_FLAGS}")

add_executable(eleagent-voice main.cc)
target_link_libraries(eleagent-voice sherpa-onnx-c-api)
