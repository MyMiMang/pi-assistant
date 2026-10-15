/**
 * 本地 SenseVoice sidecar 的 Python 入口脚本（**安装时生成到我们自己的目录**，不随 App bundle 分发权重）。
 *
 * 设计边界：
 *  - 只绑 `127.0.0.1`，每次启动一个新 token（由 manager 生成，经环境变量传入，不落盘）；
 *  - 只做「收 16k mono 16bit WAV → 离线识别 → 返回 JSON」，**不落任何音频文件、不写日志正文**；
 *  - 不做任何 VAD / 流式（SenseVoice 是离线模型；分段由上层决定）；
 *  - **不启用 CoreML / GPU**（上游未证 SenseVoice 的加速声明）。
 *
 * 该脚本在真实安装时才写盘；测试**不执行**它（用假的识别器证明协议与生命周期）。
 */
export function serveScriptSource(): string {
	return `# -*- coding: utf-8 -*-
# 由 Pi Assistant 生成本地 SenseVoice sidecar；请勿手工修改（重装会覆盖）。
import array, json, os, sys, wave, io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.environ.get("ASR_ROOT", "")
HOST = os.environ.get("ASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("ASR_PORT", "0"))
TOKEN = os.environ.get("ASR_TOKEN", "")
THREADS = int(os.environ.get("ASR_THREADS", "4"))
SAMPLE_RATE = 16000
MAX_BYTES = int(os.environ.get("ASR_MAX_BYTES", str(8 * 1024 * 1024)))

MODEL = os.path.join(ROOT, "weights", "model.int8.onnx")
TOKENS = os.path.join(ROOT, "weights", "tokens.txt")

import sherpa_onnx  # noqa: E402

recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=MODEL, tokens=TOKENS, num_threads=THREADS, use_itn=True, language="auto", debug=False
)


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
            return self._json(200, {"status": "ok", "device": "cpu", "loaded": [os.path.basename(MODEL)]})
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
