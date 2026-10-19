"""Offline lookup in the shared Hugging Face Hub cache; no model downloads."""
import os
from pathlib import Path


def hub_cache():
    home = os.environ.get('HF_HOME')
    if home is None:
        home = str(Path(os.environ.get('XDG_CACHE_HOME', str(Path.home() / '.cache'))) / 'huggingface')
    return Path(os.environ.get('HF_HUB_CACHE', os.environ.get('HUGGINGFACE_HUB_CACHE', str(Path(home) / 'hub')))).expanduser()


def cached_model_path(repo, filename, revision=None):
    """Return an existing snapshot file; never choose an arbitrary revision."""
    root = hub_cache() / ('models--' + repo.replace('/', '--'))
    if revision is None:
        ref = root / 'refs' / 'main'
        if not ref.is_file():
            return None
        revision = ref.read_text().strip()
    if not revision or '/' in revision or '..' in revision:
        return None
    candidate = root / 'snapshots' / revision / filename
    return str(candidate) if candidate.is_file() else None
