#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ORALSCALE_SRC="$HERE"
if [ -f "$HERE/secret.env" ]; then
  set -a; . "$HERE/secret.env"; set +a
fi
case "${ORALSCALE_LOCAL_MODEL_KEY:-qwen3.5-4b}" in
  qwen3.5-4b) ;;
  qwen2.5-3b) exec bash "$HERE/setup-legacy.sh" ;;
  *) echo 'Unknown local model profile'; exit 1 ;;
esac

apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y tzdata --no-install-recommends ffmpeg build-essential ninja-build python3-dev python3-pip python3-venv libgomp1 libcurl4 libssl-dev
python3 -m venv "$HERE/.venv"
PYTHON="$HERE/.venv/bin/python"
# Pin pip before resolving anything. Ubuntu 22.04's venv ships pip 22.0.2, whose resolver
# crashes (AssertionError in get_topological_weights) when it has to backtrack; that
# happened on 2026-09-29 when huggingface-hub 2.0.0 was published and the image build
# failed. Only top-level packages are pinned, so a new transitive release can force a
# backtrack at any time; a current pip resolves it (to huggingface-hub 1.33.0 that day).
"$PYTHON" -m pip install --no-cache-dir "pip==24.3.1"
"$PYTHON" -m pip install --no-cache-dir "cmake==3.31.6" "faster-whisper==1.1.0" "requests==2.32.5"
export PATH="$HERE/.venv/bin:$PATH"
if [ "${ORALSCALE_SKIP_LOCAL_LLM:-0}" != "1" ]; then
  "$PYTHON" "$HERE/install_runtime.py"
elif [ "${ORALSCALE_LOCAL_REQUIRED:-0}" = "1" ]; then
  echo 'Cannot skip the required local grader'; exit 1
fi
"$PYTHON" - <<'PY'
import os,sys
sys.path.insert(0,os.environ['ORALSCALE_SRC'])
import transcribe
from faster_whisper import WhisperModel
speech=WhisperModel(os.environ.get("ORALSCALE_WHISPER_MODEL", transcribe.DEFAULT_MODEL),device='cpu',compute_type='int8')
del speech
print('Transcription weights cached.')
PY
if [ "${ORALSCALE_SKIP_LOCAL_LLM:-0}" != "1" ]; then
"$PYTHON" - <<'PY'
import os,sys
sys.path.insert(0,os.environ['ORALSCALE_SRC'])
import qwen35 as lm
try:
 url=lm._ensure_server()
 out=lm._post(url,'/v1/chat/completions',{'model':'local','messages':[{'role':'user','content':'Reply only OK.'}],'max_tokens':8,'temperature':0,'chat_template_kwargs':{'enable_thinking':False},'reasoning_budget_tokens':0},120)
 assert out['choices'][0]['message']['content'].strip()
 print('Transcription cached; pinned Qwen3.5 CPU runtime responds with thinking disabled.')
finally:lm.release()
PY
fi
cat <<'NOTE'
Local profile qwen35-context-off-v1: Qwen3.5 4B Q4_K_M, enhanced context, thinking OFF.
Gradescope settings: 4 CPU / 6 GB RAM; 40-minute timeout; Ubuntu 22.04 or newer.
Model weights are cached in this image. Submission grading needs no network.
The existing identity, certificate, timing and submission-integrity checks remain active.
NOTE
