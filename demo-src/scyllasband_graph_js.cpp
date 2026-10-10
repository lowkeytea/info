// Browser build of libscyllasband: the unchanged engine and text front end, with every graph call forwarded to
// JavaScript (onnxruntime-web in the demo's worker). Graph::run() calls Module.runGraph(component, inputs), which
// returns a Promise; EM_ASYNC_JS + Asyncify let the synchronous C++ engine wait on it.
#include "scyllasband.h"
#include "scyllasband_graph.h"

#include <emscripten.h>

#include <cstdint>
#include <cstdlib>
#include <stdexcept>

EM_ASYNC_JS(int, sb_js_run, (const char* component, int count, const int* types, const int* ranks, const int64_t* dims,
                             const uint32_t* datas, uint32_t* out_ptr, int64_t* out_shape, int* out_rank), {
  try {
    const name = UTF8ToString(component);
    const inputs = [];
    let d = 0;
    for (let i = 0; i < count; i++) {
      const type = HEAP32[(types >> 2) + i], rank = HEAP32[(ranks >> 2) + i], shape = [];
      for (let r = 0; r < rank; r++) shape.push(Number(HEAP64[(dims >> 3) + d++]));
      const n = shape.reduce((a, b) => a * b, 1), ptr = HEAPU32[(datas >> 2) + i];
      const data = type === 0 ? HEAPF32.slice(ptr >> 2, (ptr >> 2) + n)
                 : type === 1 ? HEAP64.slice(ptr >> 3, (ptr >> 3) + n)
                 : HEAPU8.slice(ptr, ptr + n);
      inputs.push({ type: ['float32', 'int64', 'bool'][type], data, shape });
    }
    const out = await Module.runGraph(name, inputs);
    const p = _malloc(out.data.length * 4);
    HEAPF32.set(out.data, p >> 2);
    HEAPU32[out_ptr >> 2] = p;
    HEAP32[out_rank >> 2] = out.shape.length;
    for (let r = 0; r < out.shape.length; r++) HEAP64[(out_shape >> 3) + r] = BigInt(out.shape[r]);
    return out.data.length;
  } catch (e) {
    Module.graphError = e;
    return -1;
  }
});

// Streaming events go to Module.onEvent, which must copy `samples` before returning. A nonzero return stops synthesis.
EM_JS(int, sb_js_event, (int type, int chunk_index, int chunk_count, const float* samples, int sample_count,
                         const char* metadata), {
  const audio = samples ? HEAPF32.subarray(samples >> 2, (samples >> 2) + sample_count) : null;
  return Module.onEvent(type, chunk_index, chunk_count, audio, metadata ? UTF8ToString(metadata) : null) | 0;
});

namespace scyllasband {
namespace {

class JsGraph final : public Graph {
public:
    explicit JsGraph(std::string component) : component_(std::move(component)) {}
    GraphOutput run(const std::vector<TensorView>& inputs) override {
        std::vector<int> types, ranks;
        std::vector<int64_t> dims;
        std::vector<uint32_t> datas;
        for (const TensorView& view : inputs) {
            types.push_back(static_cast<int>(view.type));
            ranks.push_back(static_cast<int>(view.shape.size()));
            dims.insert(dims.end(), view.shape.begin(), view.shape.end());
            datas.push_back(static_cast<uint32_t>(reinterpret_cast<uintptr_t>(view.data)));
        }
        uint32_t out = 0;
        int64_t shape[8] = {0};
        int rank = 0;
        const int n = sb_js_run(component_.c_str(), static_cast<int>(inputs.size()), types.data(), ranks.data(), dims.data(),
                                datas.data(), &out, shape, &rank);
        if (n < 0) throw std::runtime_error("graph " + component_ + " failed");
        GraphOutput result;
        result.shape.assign(shape, shape + rank);
        float* values = reinterpret_cast<float*>(static_cast<uintptr_t>(out));
        result.values.assign(values, values + n);
        std::free(values);
        return result;
    }

private:
    std::string component_;
};

class JsBackend final : public Backend {
public:
    const char* name() const override { return "onnx"; }  // the bundle flavor whose manifest this build reads
    std::unique_ptr<Graph> open(const std::string& component, const Json&) override { return std::make_unique<JsGraph>(component); }
};

int32_t forward_event(const ScyllasBandEvent* event, void*) {
    return sb_js_event(static_cast<int>(event->type), event->chunk_index, event->chunk_count, event->samples,
                       static_cast<int>(event->sample_count), event->metadata_json);
}

}  // namespace

std::unique_ptr<Backend> make_backend(const BackendOptions&) { return std::make_unique<JsBackend>(); }

}  // namespace scyllasband

extern "C" {

EMSCRIPTEN_KEEPALIVE ScyllasBandRuntime* sb_create(const char* bundle_dir) {
    ScyllasBandRuntimeOptions options{bundle_dir, 0, SCYLLASBAND_ACCELERATOR_CPU};
    ScyllasBandRuntime* runtime = nullptr;
    return scyllasband_runtime_create(&options, &runtime) == SCYLLASBAND_OK ? runtime : nullptr;
}

EMSCRIPTEN_KEEPALIVE const char* sb_voices(ScyllasBandRuntime* runtime) { return scyllasband_voices_json(runtime); }

// Speaks `text` through Module.onEvent. Returns a ScyllasBandStatus. seed < 0 draws fresh noise.
EMSCRIPTEN_KEEPALIVE int sb_stream(ScyllasBandRuntime* runtime, const char* text, const char* voice, const char* language,
                                   const char* delivery, float speed, int32_t seed) {
    ScyllasBandRequest request;
    scyllasband_request_init(&request);
    request.text = text;
    request.voice_id = voice;
    request.language = language;
    request.delivery = delivery;
    request.speed = speed;
    request.seed = static_cast<uint64_t>(seed < 0 ? 0 : seed);
    request.has_seed = seed >= 0;
    return static_cast<int>(scyllasband_synthesize_stream(runtime, &request, scyllasband::forward_event, nullptr));
}

}
