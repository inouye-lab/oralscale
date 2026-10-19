"""INV-USE-6: execution timings only; never capture inputs or exception messages."""
from contextlib import contextmanager
from datetime import datetime
from functools import wraps
import time
import os
from threading import RLock, Event, Thread
import uuid
import hashlib
from pathlib import Path
try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python 3.8 remains supported for local tests.
    ZoneInfo = None
ZONE_NAME = 'America/Indiana/Indianapolis'
ZONE = ZoneInfo(ZONE_NAME) if ZoneInfo else None
_TZ_LOCK = RLock()


def timestamp(epoch):
    fmt = '%A, %B %d, %Y at %I:%M:%S %p %Z (UTC%z)'
    if ZONE is not None:
        return datetime.fromtimestamp(epoch, ZONE).strftime(fmt)
    # libc reads the same IANA database on supported macOS/Linux Python 3.8.
    # Restore the process timezone even if formatting fails.
    with _TZ_LOCK:
        old = os.environ.get('TZ')
        try:
            os.environ['TZ'] = ZONE_NAME
            time.tzset()
            return time.strftime(fmt, time.localtime(epoch))
        finally:
            if old is None:
                os.environ.pop('TZ', None)
            else:
                os.environ['TZ'] = old
            time.tzset()


def duration(seconds):
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(int(minutes), 60)
    return f'{hours}h {minutes}m {seconds:.3f}s'


class Timeline:
    def __init__(self, wall=time.time, monotonic=time.monotonic):
        self.wall, self.monotonic = wall, monotonic
        self.start = wall()
        self.tick = monotonic()
        self.stage_start = (self.start, self.tick)
        self.stage_name = 'Initialization and submission validation'
        self.stages, self.events = [], []
        self.counts = {}
        self.end = None
        self.memory = None
        self.run_id = uuid.uuid4().hex[:12]
        self.console = False
        self.diagnostics = []
        self._done = Event()

    def emit(self, event):
        if not self.console:
            return
        line = f'[oralscale lifecycle run={self.run_id}] {timestamp(self.wall())} | +{max(0, self.monotonic()-self.tick):.3f}s | {event}'
        self.diagnostics.append(line)
        try:
            print(line, flush=True)
        except (OSError, ValueError):
            pass

    def start_console(self):
        self.console = True
        self.emit('PYTHON_STARTED')
        manifest = Path(__file__).with_name('local-profile.json')
        try:
            if manifest.is_file():
                self.emit('PACKAGE_PROFILE_SHA256=' + hashlib.sha256(manifest.read_bytes()).hexdigest())
        except OSError:
            self.emit('PACKAGE_PROFILE_SHA256 unavailable')
        def heartbeat():
            while not self._done.wait(60):
                self.heartbeat()
        Thread(target=heartbeat, daemon=True).start()

    def heartbeat(self):
        self.emit('HEARTBEAT stage=' + self.stage_name)
        try:
            if self.memory and self.memory.samples:
                current = self.memory.samples[-1][1] / 1024**3
                limit = self.memory.limit
                cap = f'{limit/1024**3:.3f}' if limit is not None else 'unavailable'
                self.emit(f'MEMORY last_sample_charge_GiB={current:.3f} cap_GiB={cap}')
        except Exception:
            self.emit('MEMORY sample unavailable')

    def start_resources(self):
        try:
            from resourcestats import MemoryMonitor
            self.memory = MemoryMonitor()
            self.memory.start()
        except Exception:
            self.memory = None

    def _row(self, name, start, end, status='completed'):
        return dict(name=name, start=start[0], finish=end[0], seconds=max(0, end[1]-start[1]), status=status)

    def stage(self, name):
        if self.memory:
            self.memory.sample()
        now = (self.wall(), self.monotonic())
        self.stages.append(self._row(self.stage_name, self.stage_start, now))
        self.emit("STAGE_COMPLETED " + self.stage_name)
        self.stage_name, self.stage_start = name, now
        self.emit("STAGE_STARTED " + name)

    @contextmanager
    def span(self, name):
        self.counts[name] = self.counts.get(name, 0) + 1
        label = f'{name} #{self.counts[name]}'
        start = (self.wall(), self.monotonic())
        status = 'completed'
        self.emit('SPAN_STARTED ' + label)
        try:
            yield
        except BaseException:
            status = 'interrupted/failed'
            raise
        finally:
            self.events.append(self._row(label, start, (self.wall(), self.monotonic()), status))
            self.emit("SPAN_" + status.upper() + " " + label)

    def finish(self):
        if self.end is None:
            self.end = (self.wall(), self.monotonic())
            self.stages.append(self._row(self.stage_name, self.stage_start, self.end))
        seconds = max(0, self.end[1] - self.tick)
        summary = (f'Grading started: {timestamp(self.start)}\n'
                   f'Grading finished: {timestamp(self.end[0])}\n'
                   f'Total grading time: {duration(seconds)} ({seconds:.3f} seconds)\n'
                   'Times are Purdue local time (America/Indiana/Indianapolis).')
        detail = [summary, 'Scope: Python grader start through result preparation. Excludes Gradescope queue, image setup and final result-file write.',
                  'Main stages (non-overlapping; includes all time between stages):']
        for row in self.stages:
            detail.append(self.format_row(row))
        if self.events:
            detail.append('Nested model timings (already included in main stages; do not add again). Answer attempts include readiness, prompt preparation and response validation. Inference includes prompt evaluation and token generation; retries appear as additional attempts.')
            for row in sorted(self.events, key=lambda r: r['start']):
                detail.append(self.format_row(row))
        if self.memory:
            try:
                detail.append(self.memory.finish(timestamp))
            except Exception:
                detail.append('Memory diagnostics unavailable; grading unaffected.')
        detail.append('Lifecycle diagnostics (instructor only):\n' + '\n'.join(self.diagnostics) + '\nResults-write, shutdown and launcher-exit markers occur later in instructor console output. Their absence does not establish a platform fault.')
        return summary, '\n\n'.join(detail)

    @staticmethod
    def format_row(row):
        return (f"{row['name']} [{row['status']}]\n"
                f"  Started: {timestamp(row['start'])}\n"
                f"  Finished: {timestamp(row['finish'])}\n"
                f"  Elapsed: {duration(row['seconds'])} ({row['seconds']:.3f} seconds)")


current = Timeline()


def measured(name, question=False):
    def decorate(fn):
        @wraps(fn)
        def call(*args, **kwargs):
            label = name
            if question:
                q = args[0] if args else kwargs.get('question', {})
                label += ' (question ' + str(q.get('id', 'unknown')) + ')'
            with current.span(label):
                return fn(*args, **kwargs)
        return call
    return decorate


def feedback_first(tests):
    def order(t):
        name = t.get('name', '')
        if (name.startswith('Question ') and ' of ' in name) or name == 'Feedback on your explanation':
            return 0
        return 1 if name.startswith('Overall Score') else 2
    return sorted(tests, key=order)
