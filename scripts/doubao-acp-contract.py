"""No-account probe, run via doubao-acp-contract.sh in the offline container."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tarfile
import time


ROOT = Path('/tmp/doubao-contract')
HOME = ROOT / 'home'
CWD = ROOT / 'work'
DATA = HOME / 'data'
CURRENT = DATA / 'doubao_cli/app/current'
LIMIT = 32768


def emit(**fields):
    print(json.dumps(fields, ensure_ascii=True), flush=True)


def probe(argv, payload=None):
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(HOME),
           'DOUBAO_CLI_NO_UPDATE_CHECK': '1'}
    for key, path in {'XDG_DATA_HOME': DATA, 'XDG_CONFIG_HOME': HOME / 'config',
                      'XDG_CACHE_HOME': HOME / 'cache', 'XDG_STATE_HOME': HOME / 'state',
                      'XDG_RUNTIME_DIR': HOME / 'runtime', 'TMPDIR': HOME / 'tmp'}.items():
        path.mkdir(mode=0o700, exist_ok=True)
        env[key] = str(path)
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    handshake = None
    reason = 'exit'
    with subprocess.Popen([str(CURRENT / 'doubao'), *argv], cwd=CWD, env=env,
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          start_new_session=True) as child, selectors.DefaultSelector() as sel:
        try:
            if payload is not None:
                child.stdin.write(json.dumps(payload).encode() + b'\n')
                child.stdin.flush()
            else:
                child.stdin.close()
            for key in output:
                sel.register(getattr(child, key), selectors.EVENT_READ, key)
            deadline = time.monotonic() + 18
            while sel.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    reason = 'timeout'
                    break
                for event, _ in sel.select(remaining):
                    chunk = os.read(event.fd, 4096)
                    if not chunk:
                        sel.unregister(event.fileobj)
                        continue
                    buf = output[event.data]
                    buf.extend(chunk[:LIMIT - len(buf)])
                    if len(buf) >= LIMIT:
                        reason = 'output_limit'
                        break
                    if payload is not None and event.data == 'stdout':
                        for line in buf.split(b'\n')[:-1]:
                            try:
                                reply = json.loads(line)
                            except (ValueError, UnicodeError):
                                continue
                            if isinstance(reply, dict) and reply.get('jsonrpc') == '2.0' and type(reply.get('id')) is int and reply['id'] == 1:
                                handshake = reply
                                reason = 'initialize_response'
                                break
                    if handshake is not None:
                        break
                if reason != 'exit':
                    break
        except BrokenPipeError:
            reason = 'stdin_closed'
        finally:
            try:
                child.stdin.close()
            except BrokenPipeError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
                reason += '_forced_stop'
        emit(event='command', argv=argv, exit=child.returncode, stop=reason,
             **{key: value.decode('utf-8', 'replace') for key, value in output.items()})
        return handshake, child.returncode


def logs():
    # Read only native logs created under this empty profile; no auth files or directory dump.
    directory = DATA / 'doubao_cli/logs/native'
    if any(p.is_symlink() for p in [DATA, DATA / 'doubao_cli', directory.parent, directory]):
        return
    for file in sorted(directory.glob('doubao-????????.log'))[:2]:
        if file.is_symlink() or not file.is_file():
            continue
        with file.open('rb') as stream:
            stream.seek(max(0, file.stat().st_size - LIMIT))
            text = stream.read(LIMIT).decode('utf-8', 'replace')
        emit(event='native_diagnostics', lines=[line[:500] for line in text.splitlines()
             if any(marker in line for marker in ('peer.pidfd_open', 'untrusted_peer', 'stage=bind.ready',
                                                  'Started detached process', 'stage=discovery.failed'))][-30:])


def main():
    os.umask(0o077)
    if os.uname().machine != 'x86_64' or sys.platform != 'linux' or os.geteuid() == 0:
        emit(recorded=True, handshake=False, stage='container_preflight')
        return 1
    try:
        os.close(os.pidfd_open(os.getpid()))
    except (OSError, AttributeError) as error:
        emit(recorded=True, handshake=False, stage='pidfd_open', errno=getattr(error, 'errno', None))
        return 1
    emit(event='preflight', architecture=os.uname().machine, pidfd_open=True)
    HOME.mkdir(parents=True)
    CWD.mkdir()
    staging = ROOT / 'archive'
    staging.mkdir()
    with tarfile.open(fileobj=sys.stdin.buffer, mode='r|gz') as archive:
        for member in archive:
            if not (member.isdir() or member.isfile()) or Path(member.name).parts[0] != 'doubao-cli-2.38.2-linux-x64':
                raise ValueError('unexpected archive member')
            archive.extract(member, staging, filter='data')
    CURRENT.parent.mkdir(parents=True)
    (staging / 'doubao-cli-2.38.2-linux-x64').rename(CURRENT)
    manifest = json.loads((CURRENT / 'manifest.json').read_text())
    if (manifest['version'], manifest['target'], manifest['entrypoint']) != ('2.38.2', 'linux-x64', 'doubao'):
        raise ValueError('unexpected release manifest')
    _, version_exit = probe(['--version'])
    _, help_exit = probe(['acp', '--help'])
    response, _ = probe(['acp', 'serve'], {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                        'params': {'protocolVersion': 1, 'clientCapabilities': {},
                                   'clientInfo': {'name': 'pi-contract-probe', 'version': '1'}}})
    logs()
    result = response.get('result') if response else None
    ok = (isinstance(result, dict) and type(result.get('protocolVersion')) is int
          and result['protocolVersion'] == 1 and 'error' not in response)
    emit(recorded=True, handshake=ok, stage='initialize', response=response,
         version_exit=version_exit, help_exit=help_exit)
    return 0 if ok and version_exit == 0 and help_exit == 0 else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        emit(recorded=False, handshake=False, stage='harness_error', error_type=type(error).__name__)
        sys.exit(1)
