"""Pinned Qwen3.5 runtime for the versioned local grading profile.

One model, one question at a time. Complete judgments always become grades.
Uncertainty/evidence flags are diagnostic; infrastructure failures are errors.
"""
from __future__ import annotations
import atexit
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import pointscore
import runtiming
import localcontext
import bands as bands_mod
from modelcache import cached_model_path

HERE = Path(__file__).resolve().parent
DEFAULT_FILE = 'Qwen3.5-4B-Q4_K_M.gguf'
DEFAULT_REPO = 'unsloth/Qwen3.5-4B-GGUF'
DEFAULT_CTX = 4096
PROFILE = localcontext.PROFILE
_SERVER = None
_SERVER_LOG = None
_URL = None
_ERROR = None
LAST_DIAGNOSTIC = None



def model_path():
    explicit = os.environ.get('ORALSCALE_LOCAL_PATH')
    if explicit:
        p = Path(explicit).expanduser()
        return str(p) if p.is_file() else None
    p = HERE / 'models' / DEFAULT_FILE
    if p.is_file():
        return str(p)
    spec = json.loads((HERE / 'runtime-manifest.json').read_text())['model']
    return cached_model_path(spec['repo'], spec['file'], spec['revision'])


def local_model_name():
    return 'Qwen3.5-4B-Q4_K_M/context/thinking-off'


def _loopback(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme != 'http' or p.hostname != '127.0.0.1' or p.username or p.password or p.path not in ('', '/') or not p.port:
        raise ValueError('Local inference must use a plain loopback URL')
    return url.rstrip('/')


def local_url():
    explicit = os.environ.get('ORALSCALE_LOCAL_URL')
    return _loopback(explicit) if explicit else _URL


def server_path():
    explicit = os.environ.get('ORALSCALE_LLAMA_SERVER')
    if explicit:
        return Path(explicit)
    pointer = HERE / 'runtime' / 'server-path.txt'
    return HERE / 'runtime' / pointer.read_text().strip() if pointer.exists() else HERE / 'runtime' / 'llama-server'


def available():
    return bool(local_url() or (model_path() and server_path().is_file()))


def unavailable_reason():
    return _ERROR or 'Pinned model or llama-server missing; run setup.sh to build the image.'


def release():
    global _SERVER, _SERVER_LOG, _URL
    if _SERVER is not None and _SERVER.poll() is None:
        runtiming.current.emit("MODEL_SHUTDOWN_STARTED")
        _SERVER.terminate()
        try:
            _SERVER.wait(timeout=10)
        except subprocess.TimeoutExpired:
            _SERVER.kill()
            _SERVER.wait()
    if _SERVER is not None:
        runtiming.current.emit("MODEL_SHUTDOWN_COMPLETED exit_code=" + str(_SERVER.returncode))
    if _SERVER_LOG is not None:
        _SERVER_LOG.close()
    _SERVER = _SERVER_LOG = _URL = None


atexit.register(release)


@runtiming.measured("Local model readiness (load on first call)")
def _ensure_server():
    global _SERVER, _SERVER_LOG, _URL
    if os.environ.get('ORALSCALE_LOCAL_URL'):
        return local_url()
    if _SERVER is not None and _SERVER.poll() is None:
        return _URL
    release()
    if not model_path():
        raise RuntimeError('Pinned model is not installed')
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    binary = server_path()
    env = dict(os.environ)
    env['LD_LIBRARY_PATH'] = str(binary.parent) + ':' + env.get('LD_LIBRARY_PATH', '')
    args = [str(binary), '-m', model_path(), '-c', '4096', '-b', '256', '-np', '1',
            '-t', '4', '-tb', '4', '-ngl', '0', '--no-repack', '--host', '127.0.0.1',
            '--port', str(port), '--jinja', '--reasoning', 'off', '--reasoning-budget', '0',
            '--no-context-shift', '--cache-ram', '0', '--no-webui']
    _SERVER_LOG = tempfile.TemporaryFile()
    _SERVER = subprocess.Popen(args, env=env, stdout=_SERVER_LOG, stderr=subprocess.STDOUT)
    # Diagnostic only: verify the live model belongs to the cap being measured.
    try:
        if runtiming.current.memory:
            runtiming.current.memory.record_model(_SERVER.pid)
    except Exception:
        pass
    _URL = 'http://127.0.0.1:' + str(port)
    until = time.monotonic() + 240
    while time.monotonic() < until:
        if _SERVER.poll() is not None:
            raise RuntimeError('Pinned local server exited during startup')
        try:
            with urllib.request.urlopen(_URL + '/health', timeout=2) as r:
                if json.load(r).get('status') == 'ok':
                    return _URL
        except Exception:
            pass
        time.sleep(.2)
    release()
    raise TimeoutError('Local server did not become ready')


def messages(question, transcript, reminder=False):
    return localcontext.messages(question, transcript, reminder)


def payload(question, transcript, reminder=False, temperature=0.0):
    ids = [p['id'] for p in localcontext.criteria(question)]
    return {'model': 'local', 'messages': messages(question, transcript, reminder),
            'temperature': temperature, 'seed': 314159, 'max_tokens': 900, 'cache_prompt': False,
            'chat_template_kwargs': {'enable_thinking': False}, 'reasoning_budget_tokens': 0,
            'response_format': {'type': 'json_schema', 'json_schema':
                                {'name': 'evidence', 'strict': True, 'schema': localcontext.schema(ids)}}}


def reserve_context(tokens, output=900):
    if tokens < 0 or tokens + output + 64 > DEFAULT_CTX:
        raise ValueError('Answer exceeds the configured context; transcript was not truncated')


def _post(url, path, data, timeout):
    request = urllib.request.Request(_loopback(url) + path, json.dumps(data).encode(),
                                     {'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as r:
        return json.load(r)


def parse(out, question, transcript):
    choice = out['choices'][0]
    if choice.get('finish_reason') == 'length':
        raise ValueError('Incomplete model output; same-model retry required')
    if choice['message'].get('reasoning_content'):
        raise ValueError('Unexpected thinking in a no-thinking package')
    d = json.loads(choice['message']['content'])
    ids = [p['id'] for p in localcontext.criteria(question)]
    verdicts = {'stated', 'partly', 'absent', 'contradicted'}
    if any(not isinstance(d.get(i), dict) or d[i].get('verdict') not in verdicts or not isinstance(d[i].get('evidence'), str) for i in ids):
        raise ValueError('Missing or invalid criterion decision')
    obj = {'points': [{'id': i, **d[i]} for i in ids], 'novelPoints': d.get('novelPoints', []),
           'falseClaims': d.get('falseClaims', []), 'unclear': d.get('unclear', False)}
    flags = []
    for point in obj['points']:
        if point['verdict'] != 'absent' and (not point['evidence'] or point['evidence'] not in transcript):
            flags.append('unsupported evidence:' + point['id'])
    for field in ['novelPoints', 'falseClaims']:
        for claim in obj[field]:
            if not claim.get('quote') or claim['quote'] not in transcript:
                flags.append('unsupported ' + field + ' quote')
    if obj['unclear']:
        flags.append('unclear transcript')
    return obj, flags


@runtiming.measured("Qwen answer attempt", question=True)
def grade_one(question, transcript, fence, ladder=None, policy=None, reminder=False, temperature=0.0):
    global LAST_DIAGNOSTIC, _ERROR
    ladder = ladder or bands_mod.DEFAULT_LADDER
    try:
        url = _ensure_server()
        if policy:
            body = payload(question, transcript, reminder, temperature)
        else:
            # Compatibility for existing band-scored assignments. The points study
            # does not qualify the accuracy of this band prompt on a new model.
            import localmodel
            ladder = ladder or bands_mod.DEFAULT_LADDER
            body = {'model': 'local', 'messages': [
                {'role':'system', 'content':localmodel.system(ladder)},
                {'role':'user', 'content':localmodel.build_prompt(question, transcript, fence, ladder)}],
                'temperature':temperature, 'seed':314159, 'max_tokens':900,
                'cache_prompt':False, 'chat_template_kwargs':{'enable_thinking':False},
                'reasoning_budget_tokens':0,
                'response_format':{'type':'json_schema', 'json_schema':{'name':'band', 'strict':True,
                    'schema':{'type':'object','properties':{'band':{'type':'string','enum':ladder.names},
                    'feedback':{'type':'string'}},'required':['band','feedback'],'additionalProperties':False}}}}
            if reminder:
                body['messages'][-1]['content'] += '\nReturn a complete JSON object with band and feedback.'
        rendered = _post(url, '/apply-template', {'messages': body['messages'],
                         'chat_template_kwargs': body['chat_template_kwargs']}, 60)
        n = len(_post(url, '/tokenize', {'content': rendered['prompt'], 'add_special': False,
                     'parse_special': True}, 60)['tokens'])
        reserve_context(n)
        timeout = float(os.environ.get('ORALSCALE_LOCAL_TIMEOUT', '1000'))
        import grade
        left = grade.budget_left()
        if left is not None:
            timeout = min(timeout, max(1, left - 10))
        started = time.monotonic()
        with runtiming.current.span('Qwen inference'):
            out = _post(url, '/v1/chat/completions', body, timeout)
        if not policy:
            choice = out['choices'][0]
            if choice.get('finish_reason') == 'length' or choice['message'].get('reasoning_content'):
                raise ValueError('Incomplete or unexpected thinking output')
            obj = json.loads(choice['message']['content'])
            if obj.get('band') not in ladder.names:
                raise ValueError('Missing band decision')
            return {'score':ladder.score_of(obj['band']), 'feedback':str(obj.get('feedback','Graded.')),
                    'covered':[], 'missed':[], 'backend':'local:'+local_model_name()}
        obj, flags = parse(out, question, transcript)
        judged = pointscore.read_answer(obj, question)
        if judged is None:
            raise ValueError('No complete criterion decisions')
        result = pointscore.compute(question, judged, policy, ladder, transcript)
        result.update(feedback=pointscore.narrative_fallback(result['points']),
                      backend='local:' + local_model_name(), modelDiagnosticFlags=flags)
        LAST_DIAGNOSTIC = {'raw': out, 'output': obj, 'flags': flags, 'promptTokens': n,
                           'seconds': time.monotonic() - started, 'payload': body}
        return result
    except Exception as exc:
        _ERROR = type(exc).__name__ + ': ' + str(exc)
        return {'error': _ERROR}
