"""Best-effort container-cap diagnostics; no student data or external commands."""
import os
from pathlib import Path
import re
import resource
import sys
import threading
import time

GIB = 1024 ** 3
FILES = {'v2': ('memory.current', 'memory.peak', 'memory.max'),
         'v1': ('memory.usage_in_bytes', 'memory.max_usage_in_bytes', 'memory.limit_in_bytes')}


def number(path):
    try:
        n = int(path.read_text().strip())
        return n if 0 <= n < 2**60 else None
    except (OSError, ValueError):
        return None


def fields(path):
    try:
        return {k: int(v) for k, v in (line.split() for line in path.read_text().splitlines())}
    except (OSError, ValueError):
        return {}


def membership(text, kind):
    for line in text.splitlines():
        _, controllers, group = line.split(':', 2)
        if (kind == 'v2' and not controllers) or (kind == 'v1' and 'memory' in controllers.split(',')):
            return group
    return None


def inside(group, ancestor):
    return bool(group and ancestor and (ancestor == '/' or group == ancestor or group.startswith(ancestor.rstrip('/') + '/')))


def unescape_mount(s):
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), s)


def discover_cgroup(proc=Path('/proc')):
    """Resolve membership against mount roots, including namespaced container mounts.

    No guessed filesystem fallback: unknown scope must not look like a verified cap.
    Only return ancestors visible in this cgroup mount. Hidden host ancestors cannot
    be inspected from inside the container.
    """
    try:
        cg = (proc/'self/cgroup').read_text()
        mounts = (proc/'self/mountinfo').read_text().splitlines()
        for kind in ('v1', 'v2'):
            group = membership(cg, kind)
            if group is None:
                continue
            for line in mounts:
                left, right = line.split(' - ', 1)
                head, tail = left.split(), right.split()
                if tail[0] != ('cgroup2' if kind == 'v2' else 'cgroup'):
                    continue
                if kind == 'v1' and 'memory' not in tail[2].split(','):
                    continue
                root, mount = unescape_mount(head[3]), Path(unescape_mount(head[4]))
                if inside(group, root):
                    relative = group[len(root):].lstrip('/') if root != '/' else group.lstrip('/')
                elif group == '/':  # cgroup namespace reports its root as /.
                    relative = ''
                else:
                    continue
                if '..' in Path(relative).parts:
                    continue
                leaf = mount/relative
                if not (leaf/FILES[kind][0]).is_file():
                    continue
                groups = []
                p, logical = leaf, group
                while True:
                    paths = tuple(p/n for n in FILES[kind])
                    # With v1 hierarchy off, ancestor counters/limits don't cover us.
                    hierarchical = kind == 'v2' or number(p/'memory.use_hierarchy') == 1
                    if p == leaf or hierarchical:
                        groups.append(dict(paths=paths, group=logical, root=p,
                                           limit=number(paths[2]), hierarchical=hierarchical))
                    if p == mount:
                        break
                    p = p.parent
                    logical = str(Path(logical).parent)
                chosen = next((i for i, g in enumerate(groups) if g['limit'] is not None), 0)
                return kind, groups, chosen
    except (OSError, ValueError, IndexError):
        pass
    return None, [], 0


def find_cgroup():
    kind, groups, chosen = discover_cgroup()
    return (kind, groups[chosen]['paths']) if groups else (None, ())


def process_memory(pid, proc=Path('/proc')):
    result = {}
    try:
        for line in (proc/str(pid)/'status').read_text().splitlines():
            key, _, val = line.partition(':')
            if key in ('VmRSS', 'VmHWM', 'RssAnon', 'RssFile', 'RssShmem'):
                result[key] = int(val.split()[0])*1024
    except (OSError, ValueError):
        pass
    try:
        for line in (proc/str(pid)/'smaps_rollup').read_text().splitlines():
            key, _, val = line.partition(':')
            if key in ('Pss', 'Pss_Anon', 'Pss_File', 'Pss_Shmem'):
                result[key] = int(val.split()[0])*1024
    except (OSError, ValueError):
        pass
    return result


def system_memory(path=Path('/proc/meminfo')):
    """OS-visible view, potentially host-wide. Never use as a container limit."""
    result = {}
    try:
        for line in path.read_text().splitlines():
            key, _, value = line.partition(':')
            if key in ('MemTotal', 'MemAvailable', 'MemFree', 'SwapTotal', 'SwapFree'):
                result[key] = int(value.split()[0])*1024
    except (OSError, ValueError):
        pass
    if 'MemTotal' in result and 'MemAvailable' in result:
        result['used_or_unavailable'] = max(0, result['MemTotal']-result['MemAvailable'])
    return result


class MemoryMonitor:
    def __init__(self, interval=10, probe=None, wall=time.time):
        self.interval, self.wall = interval, wall
        if probe is None:
            self.kind, self.groups, chosen = discover_cgroup()
            self.paths = self.groups[chosen]['paths'] if self.groups else ()
            self.scope = self.groups[chosen] if self.groups else None
        else:  # Synthetic counter tests only; no scope claim from injected paths.
            self.kind, self.paths = probe()
            self.scope = None
            self.groups = []
        self.samples = []
        self.peak = self.limit = None
        self.system = {}
        self.system_peak = None
        self.model_pid = None
        self.model = {}
        self.model_in_scope = None
        self.components = {}
        self.events = {}
        self.initial_events = None
        self.swap = {}
        self.ancestors = {}
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.thread = None

    def record_model(self, pid):
        self.model_pid = pid
        self.sample()

    def sample(self):
        try:
            with self.lock:
                self.system = system_memory()
                if 'used_or_unavailable' in self.system:
                    self.system_peak = max(self.system_peak or 0, self.system['used_or_unavailable'])
                if self.model_pid:
                    for k, v in process_memory(self.model_pid).items():
                        self.model[k] = max(self.model.get(k, 0), v)
                    try:
                        group = membership(Path(f'/proc/{self.model_pid}/cgroup').read_text(), self.kind)
                        self.model_in_scope = (inside(group, self.scope['group']) and
                            (self.kind != 'v1' or self.scope['hierarchical'] or group == self.scope['group'])) if self.scope and group else None
                    except (OSError, ValueError):
                        self.model_in_scope = None
                if not self.paths:
                    return
                current, peak, limit = [number(p) for p in self.paths]
                if current is not None:
                    self.samples.append((self.wall(), current))
                if peak is not None:
                    self.peak = max(self.peak or 0, peak)
                if limit is not None:
                    self.limit = limit
                root = self.paths[0].parent
                self.components = fields(root/'memory.stat')
                events = fields(root/'memory.events') if self.kind == 'v2' else {'limit_hits': number(root/'memory.failcnt')}
                self.events = {k:v for k,v in events.items() if v is not None}
                if self.initial_events is None:
                    self.initial_events = dict(self.events)
                self.swap = ({'swap_current': number(root/'memory.swap.current'), 'swap_limit': number(root/'memory.swap.max')}
                             if self.kind == 'v2' else {'RAM_plus_swap_current': number(root/'memory.memsw.usage_in_bytes'), 'RAM_plus_swap_limit': number(root/'memory.memsw.limit_in_bytes')})
                for g in self.groups:
                    if g is self.scope or g['limit'] is None:
                        continue
                    usage = number(g['paths'][0])
                    if usage is not None:
                        old = self.ancestors.get(g['group'], {})
                        self.ancestors[g['group']] = dict(limit=g['limit'], current=usage,
                            peak=max(usage, old.get('peak', 0)))
        except Exception:
            pass  # Diagnostics must never alter grading or prevent results.

    def start(self):
        self.sample()
        if self.paths:
            self.thread = threading.Thread(target=self._loop, daemon=True)
            self.thread.start()

    def _loop(self):
        while not self.stop_event.wait(self.interval):
            self.sample()

    def amount(self, value):
        text = f'{value/GIB:.3f} GiB'
        if self.limit:
            text += f' / {self.limit/GIB:.3f} GiB = {100*value/self.limit:.1f}% of cap; {max(0,self.limit-value)/GIB:.3f} GiB headroom'
        return text

    def finish(self, stamp):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=1)
        self.sample()
        lines = ['MEMORY DIAGNOSTICS (instructor only; GiB = 1024^3 bytes)',
                 'PRIMARY: memory charged against the grading container/group limit, across its processes and charged file cache. This is not a percentage disguised as GiB, not host-wide RAM, and not a sum of child-process peaks.']
        if self.samples:
            high = max(v for _, v in self.samples)
            lines += [f'Linux cgroup {self.kind}; counter: {self.paths[0]}',
                      f'Scope membership resolved: {"yes" if self.scope else "unverified"}. Only visible enforcing ancestors can be inspected.',
                      f'Cgroup memory limit: {self.limit/GIB:.3f} GiB.' if self.limit else 'Cgroup memory limit: unavailable/unlimited; cap percentage and headroom unknown.',
                      'Latest container/group charge: '+self.amount(self.samples[-1][1]),
                      'Peak among periodic/stage-boundary samples: '+self.amount(high),
                      ('Kernel-recorded cgroup peak: '+self.amount(self.peak)+' (cgroup lifetime, possibly before this run).') if self.peak is not None else 'Kernel-recorded cgroup peak: unavailable; sampled peak may miss spikes.']
            if self.scope and self.kind == 'v1' and not self.scope['hierarchical']:
                lines.append('CAUTION: v1 hierarchical accounting is off/unknown. This group includes direct members; descendant-group charges may be excluded.')
            if self.model_in_scope is False:
                lines.append('WARNING: owned Qwen process is OUTSIDE the measured group. Do not interpret this as a full grader/model cap measurement.')
            elif self.model_in_scope:
                lines.append('Owned live Qwen process membership: verified inside the measured cgroup/subtree.')
            else:
                lines.append('Live Qwen membership: unverified/not started/external. This report cannot confirm model inclusion.')
            lines.append('History samples every %.0f seconds plus boundaries; chart shows roughly one minute apart and the observed maximum. Bars use the full cap as scale (or sampled maximum if cap unavailable).' % self.interval)
            high_index = max(range(len(self.samples)), key=lambda i: self.samples[i][1])
            last = float('-inf')
            for i, (when, value) in enumerate(self.samples):
                if when-last < 60 and i != high_index and i != len(self.samples)-1:
                    continue
                last = when
                scale = self.limit or max(high, 1)
                bar = '#' * min(24, max(1, round(24*value/scale)))
                lines.append(f'{stamp(when)}\n  {self.amount(value)} {bar}')
            if self.ancestors:
                lines.append('Other visible enforcing groups (can be shared with sibling workloads; headroom is not reserved):')
                for group, a in self.ancestors.items():
                    lines.append(f"{group}: latest {a['current']/GIB:.3f} / {a['limit']/GIB:.3f} GiB; sampled peak {100*a['peak']/a['limit']:.1f}% of cap; minimum sampled headroom {max(0,a['limit']-a['peak'])/GIB:.3f} GiB")
            keys = ('anon','file','shmem','kernel') if self.kind == 'v2' else ('rss','cache','mapped_file','total_rss','total_cache','total_mapped_file','total_swap')
            lines.append('Final memory.stat components (GiB; fields overlap, do not sum all): '+', '.join(f'{k}={self.components[k]/GIB:.3f}' for k in keys if k in self.components))
            lines.append('Swap accounting (separate from the RAM cap): '+(', '.join(f'{k}={v/GIB:.3f} GiB' for k,v in self.swap.items() if v is not None) or 'unavailable'))
            lines.append('Limit/OOM counters, change since first sample: '+(', '.join(f'{k}={v} (delta {v-self.initial_events.get(k,v)})' for k,v in self.events.items()) or 'unavailable'))
        else:
            lines.append('Container memory unavailable here; no whole-container peak or cap headroom can be claimed.')
        if self.system:
            lines.append('OS-VISIBLE WHOLE-SYSTEM RAM (may describe the shared host; NOT the container cap): '+', '.join(f'{k}={v/GIB:.3f} GiB' for k,v in self.system.items())+'. Used/unavailable is MemTotal minus MemAvailable, not just process allocations.')
            if self.system_peak is not None:
                lines.append(f'Peak sampled OS-wide used/unavailable RAM: {self.system_peak/GIB:.3f} GiB. Other host workloads can change this number.')
        else:
            lines.append('OS-wide /proc/meminfo unavailable.')
        if self.model:
            lines.append('SUPPLEMENTARY live Qwen footprint (not added to cgroup totals): '+', '.join(f'{k}={v/GIB:.3f} GiB' for k,v in self.model.items())+'. Sampled maxima, except VmHWM is kernel process lifetime peak. RSS includes shared resident pages; PSS apportions shared pages.')
        else:
            lines.append('Live Qwen RSS/PSS unavailable. No full-model footprint estimate can be inferred from Python RSS.')
        scale = 1 if sys.platform == 'darwin' else 1024
        try:
            lines.append('SUPPLEMENTARY Python process peak RSS: %.3f GiB; not the container total.' % (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*scale/GIB))
        except Exception:
            pass
        lines.append('Shared memory-mapped model pages can be charged to another cgroup. Cap charge can therefore be lower than resident model RSS; this does not prove the model fits in a smaller cold/isolated container. Headroom is an observation, not a future guarantee.')
        return '\n\n'.join(lines)
