"""Resource measurement utilities for RESEARCH-CAD-005.

Peak resident memory measurement strategy (recorded honestly, per issue
#5's "peak resident memory" evidence requirement):

- In-process phases: Linux ``/proc/self/status`` ``VmHWM`` (peak
  resident set high-water mark, kB). VmHWM is monotonic within a
  process, so per-phase deltas are reported as
  ``hwm_after - hwm_before`` (the additional peak grown by the phase)
  alongside the absolute high-water mark — never presented as a
  phase-local peak, which /proc does not expose.
- Child processes (the FreeCAD engine runner): a watcher thread polls
  ``/proc/<pid>/status`` while the child runs and records the maximum
  observed ``VmRSS``/``VmHWM`` plus CPU time from
  ``resource.getrusage(RUSAGE_CHILDREN)`` deltas.

No third-party process library is used (no psutil): everything reads
/proc directly so the pinned toolchain stays minimal and the
measurement itself is reproducible.
"""
from __future__ import annotations

import os
import resource
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional


def _status_field(pid: int, field_name: str) -> Optional[int]:
    """Read a numeric field (kB) from /proc/<pid>/status."""
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith(field_name + ":"):
                    parts = line.split()
                    # e.g. "VmHWM:\t 123456 kB"
                    return int(parts[1])
    except (OSError, IndexError, ValueError):
        return None
    return None


def vm_hwm_kb() -> Optional[int]:
    """Peak resident set size of THIS process (kB), monotonic."""
    return _status_field(os.getpid(), "VmHWM")


def vm_rss_kb() -> Optional[int]:
    """Current resident set size of THIS process (kB)."""
    return _status_field(os.getpid(), "VmRSS")


def kb_to_mb(value: Optional[int]) -> Optional[float]:
    return None if value is None else round(value / 1024.0, 2)


@dataclass
class PhaseMemory:
    """Memory delta across a measured phase (honest VmHWM semantics)."""

    hwm_before_kb: Optional[int]
    hwm_after_kb: Optional[int]
    rss_before_kb: Optional[int]
    rss_after_kb: Optional[int]

    @property
    def hwm_growth_kb(self) -> Optional[int]:
        if self.hwm_before_kb is None or self.hwm_after_kb is None:
            return None
        return max(0, self.hwm_after_kb - self.hwm_before_kb)

    def to_dict(self) -> dict:
        return {
            "hwm_before_mb": kb_to_mb(self.hwm_before_kb),
            "hwm_after_mb": kb_to_mb(self.hwm_after_kb),
            "hwm_growth_mb": kb_to_mb(self.hwm_growth_kb),
            "rss_before_mb": kb_to_mb(self.rss_before_kb),
            "rss_after_mb": kb_to_mb(self.rss_after_kb),
            "semantics": (
                "VmHWM is a process-lifetime monotonic high-water mark; "
                "hwm_growth is the additional peak grown by the phase, "
                "not a phase-local peak"
            ),
        }


def phase_memory() -> PhaseMemory:
    """Snapshot current memory state; pair with another call after the phase."""
    return PhaseMemory(
        hwm_before_kb=vm_hwm_kb(),
        rss_before_kb=vm_rss_kb(),
        hwm_after_kb=None,
        rss_after_kb=None,
    )


def close_phase(start: PhaseMemory) -> dict:
    start.hwm_after_kb = vm_hwm_kb()
    start.rss_after_kb = vm_rss_kb()
    return start.to_dict()


@dataclass
class ChildResourceUsage:
    """Peak resource usage observed for a child process."""

    peak_rss_kb: Optional[int] = None
    peak_hwm_kb: Optional[int] = None
    utime_s: float = 0.0
    stime_s: float = 0.0
    samples: int = 0
    available: bool = True

    def to_dict(self) -> dict:
        return {
            "peak_rss_mb": kb_to_mb(self.peak_rss_kb),
            "peak_hwm_mb": kb_to_mb(self.peak_hwm_kb),
            "user_cpu_s": round(self.utime_s, 4),
            "sys_cpu_s": round(self.stime_s, 4),
            "watcher_samples": self.samples,
            "available": self.available,
        }


class ChildProcessWatcher:
    """Poll a child pid's /proc status while it runs.

    Usage::

        proc = subprocess.Popen(...)
        watcher = ChildProcessWatcher(proc.pid)
        watcher.start()
        proc.wait()
        usage = watcher.finish()
    """

    _POLL_INTERVAL_S = 0.02

    def __init__(self, pid: int):
        self.pid = pid
        self._usage = ChildResourceUsage()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._children_before = resource.getrusage(resource.RUSAGE_CHILDREN)

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            rss = _status_field(self.pid, "VmRSS")
            hwm = _status_field(self.pid, "VmHWM")
            if rss is None and hwm is None:
                # Process exited (or /proc unavailable) — stop sampling.
                self._stop.set()
                break
            if rss is not None:
                if self._usage.peak_rss_kb is None or rss > self._usage.peak_rss_kb:
                    self._usage.peak_rss_kb = rss
            if hwm is not None:
                if self._usage.peak_hwm_kb is None or hwm > self._usage.peak_hwm_kb:
                    self._usage.peak_hwm_kb = hwm
            self._usage.samples += 1
            time.sleep(self._POLL_INTERVAL_S)

    def finish(self) -> ChildResourceUsage:
        """Stop sampling after the child was reaped; add CPU-time deltas."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        self._usage.utime_s = after.ru_utime - self._children_before.ru_utime
        self._usage.stime_s = after.ru_stime - self._children_before.ru_stime
        if self._usage.peak_rss_kb is None and self._usage.samples == 0:
            self._usage.available = False
        return self._usage


def run_with_watcher(
    spawn: Callable[[], "subprocess.Popen"],
    wait: Callable[["subprocess.Popen"], int],
) -> tuple[int, ChildResourceUsage]:
    """Spawn a child, watch its peak RSS, return (returncode, usage)."""
    proc = spawn()
    watcher = ChildProcessWatcher(proc.pid)
    watcher.start()
    rc = wait(proc)
    usage = watcher.finish()
    return rc, usage
