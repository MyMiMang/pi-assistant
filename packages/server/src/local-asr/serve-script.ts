/**
 * 本地 ASR sidecar 的 Python 入口脚本生成（**安装时写到我们自己的目录**，不随 App bundle 分发权重）。
 *
 * 三个运行族共用一个 HTTP/鉴权/解码骨架，只有「识别器构造」不同：
 *  - `sensevoice`：`OfflineRecognizer.from_sense_voice(model, tokens, use_itn, language)`
 *  - `paraformer`：`OfflineRecognizer.from_paraformer(paraformer, tokens, num_threads, feature_dim=80)`
 *  - `whisper`：`OfflineRecognizer.from_whisper(encoder, decoder, tokens, language, task="transcribe")`
 *
 * 事实来源：`local-asr-model-catalog-2026-10-16.json`（sherpa-onnx 1.13.8 sdist 工厂方法签名）。
 * 设计边界：
 *  - 只绑 `127.0.0.1`，每次启动一个新 token（manager 生成，经环境变量传入，不落盘）；
 *  - 只做「收 16k mono 16bit WAV → 离线识别 → 返回 JSON」，**不落任何音频文件、不写日志正文**；
 *  - 不做任何 VAD / 流式（这些是离线模型；分段由上层决定）；
 *  - **不启用 CoreML / GPU**。
 *
 * 该脚本在真实安装时才写盘；测试**不执行**它（用假的识别器证明协议与生命周期）。
 */
export interface SidecarOptions {
	/** Python 识别器构造代码块（缩进已由模板处理），负责给 `recognizer` 赋值 */
	init: string;
	sampleRate: number;
	maxAudioBytes: number;
}

/** 共享的 HTTP sidecar 骨架。 */
function sidecarSource(opts: SidecarOptions): string {
	return `# -*- coding: utf-8 -*-
# 由 Pi Assistant 生成本地 ASR sidecar；请勿手工修改（重装会覆盖）。
import array, json, os, sys, wave, io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.environ.get("ASR_ROOT", "")
HOST = os.environ.get("ASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("ASR_PORT", "0"))
TOKEN = os.environ.get("ASR_TOKEN", "")
THREADS = int(os.environ.get("ASR_THREADS", "4"))
SAMPLE_RATE = ${opts.sampleRate}
MAX_BYTES = int(os.environ.get("ASR_MAX_BYTES", str(${opts.maxAudioBytes})))
MODEL_ID = os.environ.get("ASR_MODEL_ID", "")

# 权重目录由 manager 传入（多模型：每个模型自己的 weights，不再是 ROOT/weights 写死）。
_WEIGHTS = os.environ.get("ASR_WEIGHTS") or os.path.join(ROOT, "weights")

import sherpa_onnx  # noqa: E402

${opts.init}

def read_pcm(buf):
    with wave.open(io.BytesIO(buf), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1 or w.getframerate() != SAMPLE_RATE:
            raise ValueError("only 16k mono 16-bit PCM is accepted")
        frames = w.readframes(w.getnframes())
    a = array.array("h")
    a.frombytes(frames)
    return [x / 32768.0 for x in a]


class Handler(BaseHTTPRequestHandler):
    server_version = "pi-local-asr/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 不写音频 / 请求正文
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        return TOKEN and self.headers.get("authorization", "") == "Bearer " + TOKEN

    def do_GET(self):
        if self.path == "/health":
            if not self._authed():
                return self._json(401, {"error": "unauthorized"})
            return self._json(200, {"status": "ok", "device": "cpu", "loaded": LOADED, "modelId": MODEL_ID})
        return self._json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/v1/audio/transcriptions":
            return self._json(404, {"error": "not_found"})
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        try:
            n = int(self.headers.get("content-length", "0"))
        except ValueError:
            return self._json(400, {"error": "bad_length"})
        if n <= 0 or n > MAX_BYTES:
            return self._json(413, {"error": "audio_size_out_of_range"})
        buf = self.rfile.read(n)
        try:
            samples = read_pcm(buf)
        except Exception as e:
            return self._json(400, {"error": "invalid_wav", "detail": str(e)[:120]})
        stream = recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        recognizer.decode_stream(stream)
        text = stream.result.text or ""
        return self._json(200, {"text": text, "language": None, "segments": [], "audioSeconds": round(len(samples) / SAMPLE_RATE, 3)})


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    sys.stderr.write("local-asr listening on %s:%d\\n" % (HOST, httpd.server_address[1]))
    sys.stderr.flush()
    httpd.serve_forever()


if __name__ == "__main__":
    main()
`;
}

/** SenseVoice sidecar；文件角色由运行族传入（不硬编码文件名）。 */
export function senseVoiceServeScript(opts: { model: string; tokens: string; sampleRate?: number; maxAudioBytes?: number }): string {
	const sampleRate = opts.sampleRate ?? 16000;
	const model = JSON.stringify(opts.model);
	const tokens = JSON.stringify(opts.tokens);
	return sidecarSource({
		sampleRate,
		maxAudioBytes: opts.maxAudioBytes ?? 8 * 1024 * 1024,
		init: `MODEL = os.path.join(_WEIGHTS, ${model})
TOKENS = os.path.join(_WEIGHTS, ${tokens})
LANGUAGE = os.environ.get("ASR_LANGUAGE", "") or "auto"
LOADED = [os.path.basename(MODEL)]

recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=MODEL, tokens=TOKENS, num_threads=THREADS, use_itn=True, language=LANGUAGE, debug=False
)`,
	});
}

/** Paraformer sidecar（中文主力；输出无标点，feature_dim=80）。 */
export function paraformerServeScript(opts: { model: string; tokens: string; sampleRate?: number; maxAudioBytes?: number }): string {
	const model = JSON.stringify(opts.model);
	const tokens = JSON.stringify(opts.tokens);
	return sidecarSource({
		sampleRate: opts.sampleRate ?? 16000,
		maxAudioBytes: opts.maxAudioBytes ?? 8 * 1024 * 1024,
		init: `MODEL = os.path.join(_WEIGHTS, ${model})
TOKENS = os.path.join(_WEIGHTS, ${tokens})
LOADED = [os.path.basename(MODEL)]

recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
    paraformer=MODEL, tokens=TOKENS, num_threads=THREADS, feature_dim=80, debug=False
)`,
	});
}

/** Whisper sidecar（多语；language 默认 "" = 自动检测，**绝不回落引擎默认 "en"**）。 */
export function whisperServeScript(opts: { encoder: string; decoder: string; tokens: string; sampleRate?: number; maxAudioBytes?: number }): string {
	const encoder = JSON.stringify(opts.encoder);
	const decoder = JSON.stringify(opts.decoder);
	const tokens = JSON.stringify(opts.tokens);
	return sidecarSource({
		sampleRate: opts.sampleRate ?? 16000,
		maxAudioBytes: opts.maxAudioBytes ?? 8 * 1024 * 1024,
		init: `ENCODER = os.path.join(_WEIGHTS, ${encoder})
DECODER = os.path.join(_WEIGHTS, ${decoder})
TOKENS = os.path.join(_WEIGHTS, ${tokens})
# 引擎默认 language="en"；这里显式用 "" 自动检测（或 ASR_LANGUAGE 指定的 zh 等），不默认英文。
LANGUAGE = os.environ.get("ASR_LANGUAGE", "")
LOADED = [os.path.basename(ENCODER), os.path.basename(DECODER)]

recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
    encoder=ENCODER, decoder=DECODER, tokens=TOKENS, num_threads=THREADS, language=LANGUAGE, task="transcribe", debug=False
)`,
	});
}

/**
 * **原生流式** sidecar（online-zipformer 族）：sherpa-onnx `OnlineRecognizer.from_transducer`。
 *
 * 与离线 sidecar **完全分离**（不改 `OfflineRecognizer` 路径，旧模型继续 batch / 分段增量）：
 *  - 每录制一个 unique 会话：`create_stream` → `accept_waveform` → `is_ready` → `decode` → `get_result` → `is_endpoint` → `reset`；
 *  - committed / tentative **同段整体替换**（不 substring、不做口语去重）；`end` 喂尾部 silence + `input_finished` 出 final；
 *  - 会话结束 / 取消即从字典移除（lease / memory 真正释放）；只服务自己 spawn 的 worker。
 *  - 只绑 127.0.0.1，每次启动新 token；不落盘任何音频、不写请求正文。
 *
 * 该脚本在真实安装时才写盘；测试**不执行**它（用假 sidecar 证明协议与生命周期）。
 */
export function onlineZipformerServeScript(opts: { encoder: string; decoder: string; joiner: string; tokens: string; sampleRate?: number }): string {
	const sampleRate = opts.sampleRate ?? 16000;
	const encoder = JSON.stringify(opts.encoder);
	const decoder = JSON.stringify(opts.decoder);
	const joiner = JSON.stringify(opts.joiner);
	const tokens = JSON.stringify(opts.tokens);
	return `# -*- coding: utf-8 -*-
# 由 Pi Assistant 生成**原生流式**本地 ASR sidecar；请勿手工修改（重装会覆盖）。
# 只用 sherpa_onnx.OnlineRecognizer（from_transducer）；离线识别路径不受影响。
import array, json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("ASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("ASR_PORT", "0"))
TOKEN = os.environ.get("ASR_TOKEN", "")
THREADS = int(os.environ.get("ASR_THREADS", "4"))
SAMPLE_RATE = ${sampleRate}
MODEL_ID = os.environ.get("ASR_MODEL_ID", "")
MAX_CHUNK = int(os.environ.get("ASR_MAX_CHUNK", "32000"))
MAX_SESSIONS = 4

_WEIGHTS = os.environ.get("ASR_WEIGHTS") or os.path.join(os.environ.get("ASR_ROOT", ""), "weights")

import sherpa_onnx  # noqa: E402

ENCODER = os.path.join(_WEIGHTS, ${encoder})
DECODER = os.path.join(_WEIGHTS, ${decoder})
JOINER = os.path.join(_WEIGHTS, ${joiner})
TOKENS = os.path.join(_WEIGHTS, ${tokens})
LOADED = [os.path.basename(ENCODER), os.path.basename(DECODER), os.path.basename(JOINER)]

recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
    encoder=ENCODER, decoder=DECODER, joiner=JOINER, tokens=TOKENS,
    num_threads=THREADS, sample_rate=SAMPLE_RATE, feature_dim=80,
    decoding_method="greedy_search",
    enable_endpoint_detection=True,
    rule1_min_trailing_silence=2.4,
    rule2_min_trailing_silence=1.2,
    rule3_min_utterance_length=20.0,
    debug=False,
)

_lock = threading.Lock()
_sessions = {}
_seq = [0]


def _pcm_to_samples(b):
    n = len(b) // 2
    a = array.array("h")
    a.frombytes(b[: n * 2])
    return [x / 32768.0 for x in a]


def _new_session():
    with _lock:
        _seq[0] += 1
        sid = "s%d" % _seq[0]
        _sessions[sid] = {"stream": recognizer.create_stream(), "segment": 0, "prev": "", "committed": "", "finals": [], "lock": threading.Lock()}
    return sid


def _decode(sess):
    stream = sess["stream"]
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    return recognizer.get_result(stream).text or ""


def _events(sess):
    text = _decode(sess)
    prev = sess["prev"]
    committed = sess["committed"]
    c = 0
    while c < len(prev) and c < len(text) and prev[c] == text[c]:
        c += 1
    evs = []
    if c > len(committed) and text[:c].startswith(committed):
        committed = text[:c]
        sess["committed"] = committed
        evs.append({"type": "committed", "text": committed, "segmentId": sess["segment"]})
    tentative = text[len(committed):]
    evs.append({"type": "tentative", "text": tentative, "segmentId": sess["segment"]})
    sess["prev"] = text
    if recognizer.is_endpoint(sess["stream"]):
        evs.append({"type": "final", "text": text, "segmentId": sess["segment"]})
        sess["finals"].append(text)
        recognizer.reset(sess["stream"])
        sess["segment"] += 1
        sess["prev"] = ""
        sess["committed"] = ""
        evs.append({"type": "endpoint", "segmentId": sess["segment"]})
    return evs


def _finalize(sess):
    stream = sess["stream"]
    stream.accept_waveform(SAMPLE_RATE, [0.0] * int(0.5 * SAMPLE_RATE))
    stream.input_finished()
    text = _decode(sess)
    evs = []
    if text:
        evs.append({"type": "final", "text": text, "segmentId": sess["segment"]})
        sess["finals"].append(text)
    evs.append({"type": "endpoint", "segmentId": sess["segment"]})
    return evs


class Handler(BaseHTTPRequestHandler):
    server_version = "pi-local-asr-stream/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        return TOKEN and self.headers.get("authorization", "") == "Bearer " + TOKEN

    def do_GET(self):
        if self.path == "/health":
            if not self._authed():
                return self._json(401, {"error": "unauthorized"})
            return self._json(200, {"status": "ok", "device": "cpu", "loaded": LOADED, "modelId": MODEL_ID, "streaming": True})
        return self._json(404, {"error": "not_found"})

    def _body(self, limit):
        try:
            n = int(self.headers.get("content-length", "0"))
        except ValueError:
            return None
        if n < 0 or n > limit:
            return None
        return self.rfile.read(n)

    def _query(self):
        q = {}
        if "?" in self.path:
            for part in self.path.split("?", 1)[1].split("&"):
                if "=" in part:
                    k, v = part.split("=", 1)
                    q[k] = v
        return q

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        if path == "/v1/stream/start":
            with _lock:
                if len(_sessions) >= MAX_SESSIONS:
                    return self._json(429, {"error": "too_many_sessions"})
            sid = _new_session()
            return self._json(200, {"sessionId": sid, "sampleRate": SAMPLE_RATE})
        if path == "/v1/stream/append":
            body = self._body(MAX_CHUNK)
            if body is None:
                return self._json(413, {"error": "chunk_too_large"})
            sess = _sessions.get(self._query().get("session", ""))
            if not sess:
                return self._json(404, {"error": "unknown_session"})
            with sess["lock"]:
                samples = _pcm_to_samples(body)
                if samples:
                    sess["stream"].accept_waveform(SAMPLE_RATE, samples)
                evs = _events(sess)
            return self._json(200, {"events": evs})
        if path in ("/v1/stream/end", "/v1/stream/cancel"):
            body = self._body(65536)
            try:
                sid = json.loads((body or b"{}").decode("utf-8")).get("sessionId", "")
            except Exception:
                sid = ""
            sess = _sessions.pop(sid, None)
            if path == "/v1/stream/cancel":
                return self._json(200, {"ok": True})
            if not sess:
                return self._json(200, {"events": [], "finals": []})
            with sess["lock"]:
                evs = _finalize(sess)
            return self._json(200, {"events": evs, "finals": sess["finals"]})
        return self._json(404, {"error": "not_found"})


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    sys.stderr.write("local-asr-stream listening on %s:%d\\n" % (HOST, httpd.server_address[1]))
    sys.stderr.flush()
    httpd.serve_forever()


if __name__ == "__main__":
    main()
`;
}

/** 兼容旧调用：默认 SenseVoice 文件角色（新代码走运行族）。 */
export function serveScriptSource(): string {
	return senseVoiceServeScript({ model: "model.int8.onnx", tokens: "tokens.txt" });
}
