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

_WEIGHTS = os.path.join(ROOT, "weights")

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
            return self._json(200, {"status": "ok", "device": "cpu", "loaded": LOADED})
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

/** 兼容旧调用：默认 SenseVoice 文件角色（新代码走运行族）。 */
export function serveScriptSource(): string {
	return senseVoiceServeScript({ model: "model.int8.onnx", tokens: "tokens.txt" });
}
