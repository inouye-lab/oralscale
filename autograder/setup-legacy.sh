#!/usr/bin/env bash
# Gradescope autograder image build. Runs ONCE when the image is built, with network.
# Grading runs later and may have no network at all — so everything must be baked in here.
set -euo pipefail

# WHERE THIS SCRIPT LIVES — every path below is anchored here, never to $PWD.
#
# Gradescope does not promise a working directory when it runs setup.sh, and it
# is not /autograder/source. The previous version resolved "source/models"
# relative to $PWD, so on a real build the 2.1 GB model downloaded into a
# freshly-created directory nobody would ever look in, and the very next line
# failed with `ModuleNotFoundError: No module named 'localmodel'` — the modules
# being right here, next to this script, the whole time.
#
# This directory is also exactly where localmodel.model_path() looks
# (os.path.dirname(__file__) + "/models"), so anchoring here is what makes the
# download and the lookup agree.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ORALSCALE_SRC="$HERE"
echo "setup.sh: source directory is $HERE (cwd is $PWD)"

# Build-time settings live in secret.env, written by build.sh. This file was
# being composed and then never read: ORALSCALE_SKIP_LOCAL_LLM,
# ORALSCALE_LOCAL_MODEL_KEY and ORALSCALE_WHISPER_MODEL are all documented as
# taking effect "at BUILD time", and none of them did.
if [ -f "$HERE/secret.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/secret.env"
  set +a
fi

apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y tzdata --no-install-recommends \
  ffmpeg build-essential cmake ninja-build python3-dev libgomp1 python3-pip

# Local, private transcription (INV-PRIV-3). Pinned so a future release cannot
# silently change transcription behaviour between weeks of a running course.
# Pin pip first: the system pip 22.0.2 resolver crashes when it must backtrack (see
# setup.sh; image builds failed on 2026-09-29 after huggingface-hub 2.0.0 was released).
python3 -m pip install --no-cache-dir "pip==24.3.1"
pip3 install --no-cache-dir "faster-whisper==1.1.0" "requests==2.32.5"

# Fail the BUILD if transcription is unavailable. This used to be `|| true`, which
# was actively dangerous: with sidecars gated (INV-INTEGRITY-8) a container without
# Whisper produces no transcript at all, so every honest submission scores 0 and is
# flagged. Better to break the image build, where the instructor sees it.
python3 - <<'PY'
import os, sys
from faster_whisper import WhisperModel

# ONE source of truth for the default model: transcribe.py. Baking a different
# model into the image than the grader asks for at run time means a silent
# download per submission at best, and no transcript at all if the container has
# no network at grading time -- so read it rather than repeating it here.
sys.path.insert(0, os.environ["ORALSCALE_SRC"])
try:
    import transcribe as stt
    default = stt.DEFAULT_MODEL
except Exception:
    default = "small"
name = os.environ.get("ORALSCALE_WHISPER_MODEL", default)

# Download and cache the weights NOW, into the image. Grading time may be offline,
# and even when it isn't, re-fetching per submission is slow and flaky.
WhisperModel(name, device="cpu", compute_type="int8")
print("whisper model '%s' cached OK" % name)
PY

# ---------------------------------------------------------------------------
# Local grading model (gradingBackend=local, which is the DEFAULT).
#
# Baked into the image so grading needs no network and no API key, and so the
# transcript never leaves the container. Skipped only if ORALSCALE_SKIP_LOCAL_LLM=1
# -- e.g. an instructor who has committed to Purdue GenAI and wants a smaller
# image. That is a real trade: without it, a GenAI outage falls all the way back
# to keyword matching, which grades measurably worse than the local model.
# ---------------------------------------------------------------------------
if [ "${ORALSCALE_SKIP_LOCAL_LLM:-0}" != "1" ]; then
  # THE VERSION IS A MODEL-COMPATIBILITY DECISION, NOT A HOUSEKEEPING ONE.
  # llama-cpp-python carries its own copy of llama.cpp, so the pin decides which
  # model ARCHITECTURES the container can read at all. 0.3.2 predates Qwen3,
  # Qwen3.5, Gemma 3, Gemma 4 and Phi-4 — so two models that localmodel.py has
  # been OFFERING as choices could never have loaded in a real container. The
  # failure is at load time, which means it lands on the first submission of a
  # live quiz rather than in the build log. Measured against the whole candidate
  # slate in tools/eval/: every model in MODELS loads under 0.3.35, and the
  # source build below succeeds on x86_64 glibc Ubuntu with these exact
  # CMAKE_ARGS. Raise this pin whenever a model is added that needs a newer
  # llama.cpp, and re-run tools/eval/model-study.py before trusting it.
  #
  # Prebuilt CPU wheel first: building llama-cpp-python from source adds ~10
  # minutes to every image build and needs a toolchain that may not be present.
  #
  # BUT A SUCCESSFUL pip INSTALL IS NOT A WORKING LIBRARY. The wheels on that
  # index are musl-linked; Gradescope's base image is glibc Ubuntu, so the wheel
  # installs cleanly and then dies on import with
  #     libc.musl-x86_64.so.1: cannot open shared object file
  # The old `pip A || pip B` fallback could never fire, because pip A SUCCEEDED.
  # So: install, then actually import it, and only then believe it.
  pip3 install --no-cache-dir \
      --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu \
      "llama-cpp-python==0.3.35" \
    || true

  if ! LLAMA_IMPORT_ERROR="$(python3 -c "import llama_cpp" 2>&1)"; then
    echo "prebuilt llama-cpp-python wheel does not load here:"
    printf '  %s\n' "$LLAMA_IMPORT_ERROR"
    echo "Rebuilding llama-cpp-python itself from source. This takes several minutes."
    pip3 uninstall -y llama-cpp-python >/dev/null 2>&1 || true
    # The old all-packages no-binary flag propagated into pip's isolated build env and
    # forced packaging, hatchling, pluggy, setuptools-scm, vcs-versioning and
    # even tomli to compile recursively. Gradescope then died in that dependency
    # maze before it ever reached llama.cpp. Install the pinned build backend as
    # a wheel, disable isolation, and compile ONLY llama-cpp-python.
    pip3 install --no-cache-dir "scikit-build-core==0.10.7" || true
    CMAKE_ARGS="-DGGML_NATIVE=OFF -DGGML_OPENMP=ON -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_AVX512=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF" \
      pip3 install --no-cache-dir --no-build-isolation \
        --no-binary=llama-cpp-python "llama-cpp-python==0.3.35" || true
  fi

  if python3 -c "import llama_cpp" >/dev/null 2>&1; then
    LOCAL_LLM_OK=1
    pip3 install --no-cache-dir "huggingface_hub>=0.23"
  else
    LOCAL_LLM_OK=0
  fi
else
  LOCAL_LLM_OK=0
fi

# A local model that cannot be built is FATAL only for a course that grades with
# it. For a course on Purdue GenAI it is an outage fallback, and failing the
# whole image build over an unusable fallback would be the wrong trade — the
# instructor would have no autograder at all rather than one missing a backstop.
# build.sh writes ORALSCALE_LOCAL_REQUIRED from the course's own configuration.
if [ "${LOCAL_LLM_OK:-0}" != "1" ]; then
  if [ "${ORALSCALE_SKIP_LOCAL_LLM:-0}" = "1" ]; then
    echo "ORALSCALE_SKIP_LOCAL_LLM=1 -- not bundling a local grading model."
    echo "  This course grades with 'genai'. There are no grader fallbacks: if GenAI"
    echo "  is unreachable, affected submissions are NOT graded and are flagged for"
    echo "  you to regrade, rather than being scored by a different grader."
  elif [ "${ORALSCALE_LOCAL_REQUIRED:-0}" = "1" ]; then
    echo "ERROR: this course grades with gradingBackend 'local', and the local"
    echo "  model runtime could not be installed. Every submission would score 0."
    exit 1
  else
    echo "NOTE: no local grading model in this image."
    echo "  This course grades with 'genai', so nothing is lost: there are no grader"
    echo "  fallbacks, so a bundled local model could never have been used anyway."
    echo "  If GenAI is unreachable, affected submissions are NOT graded and are"
    echo "  flagged for you to regrade — never scored by a different grader."
  fi
fi

if [ "${LOCAL_LLM_OK:-0}" = "1" ]; then
  # Download the exact GGUF selected by the course into the directory
  # localmodel.model_path() searches. Installing huggingface_hub alone does not
  # download anything; without this explicit step the image reaches the smoke
  # test with a working llama_cpp runtime but no model file.
  python3 - <<'PY'
import os, sys
from huggingface_hub import hf_hub_download

sys.path.insert(0, os.environ["ORALSCALE_SRC"])
import localmodel as lm

model_dir = os.path.join(os.environ["ORALSCALE_SRC"], "models")
os.makedirs(model_dir, exist_ok=True)
path = hf_hub_download(
    repo_id=lm.DEFAULT_REPO,
    filename=lm.DEFAULT_FILE,
    local_dir=model_dir,
)
assert os.path.isfile(path), "Hugging Face download returned no model file"
print("local grading model cached OK:", lm.DEFAULT_REPO, lm.DEFAULT_FILE)
PY

  # Prove it LOADS, here, where the instructor is reading the build log -- not on
  # the first student submission. A model that downloads but will not load is the
  # same outcome as no model at all, discovered at the worst possible moment.
  python3 - <<'PY'
import os, sys
sys.path.insert(0, os.environ["ORALSCALE_SRC"])
import localmodel as lm
path = lm.model_path()
assert path, "local model file not found after download"
from llama_cpp import Llama
llm = Llama(model_path=path, n_ctx=512, n_batch=64, verbose=False)
out = llm.create_chat_completion(
    messages=[{"role": "user", "content": "Reply with only: OK"}], max_tokens=5)
print("local grading model loads and responds:",
      out["choices"][0]["message"]["content"].strip()[:20])
PY
fi

# The container must be big enough to LOAD that model, and Gradescope's default is
# not. `small` int8 peaks around 1.7 GB, so the 0.5 CPU / 0.75 GB default cannot
# run it at all and every submission comes back untranscribed -- which looks like
# a student problem and is not. Say so at BUILD time, where the instructor is
# looking, rather than leaving it to be discovered on a live quiz.
cat <<'NOTE'

  ----------------------------------------------------------------------------
  REMINDER -- Gradescope autograder settings for this assignment:
      Container : 4.0 CPU / 6.0 GB RAM   (required for local grading; the
                                          0.5 / 0.75 default cannot even load
                                          the speech model)
      Timeout   : 40 minutes             (local grading is ~10-25 s per question,
                                          and GenAI grading may wait out a rate
                                          limit on a whole-class regrade)
      Scoring   : nothing to set. Gradescope grades the ACTIVE (newest)
                  submission and has no "highest score" option on a Programming
                  Assignment; students re-activate a better attempt from
                  Submission History (INV-DEPLOY-1)
  With gradingBackend=genai and no local model bundled, 2.0 CPU / 3.0 GB is enough.
  ----------------------------------------------------------------------------

NOTE

echo "setup.sh complete: ffmpeg + faster-whisper 1.1.0 + cached speech model + local grader."
