"""Device auto-detection: CUDA, Apple MPS, or CPU.

The ticket asks for both CUDA and MPS. This machine has MPS and no NVIDIA GPU, so the CUDA branch is
covered by a unit test that monkeypatches `torch`, and the PR says exactly that. Claiming a CUDA
throughput number measured on hardware that does not exist is the kind of unverifiable claim
`CLAUDE.md` forbids.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

log = logging.getLogger("saakshi.analytics")

#: Order of preference. CUDA first: where both exist it is the faster device by a wide margin.
DEVICE_PREFERENCE = ("cuda", "mps", "cpu")


@dataclass(frozen=True)
class Device:
    """The chosen device and how it was chosen — the second half is what makes a bench table real."""

    name: str
    #: Free-text label for the run summary, e.g. "Apple MPS (Metal)".
    description: str
    #: True when `SAAKSHI_DEVICE` forced the choice rather than detection making it.
    forced: bool = False

    @property
    def half_precision(self) -> bool:
        """FP16 on CUDA only.

        ultralytics' `half=True` on MPS falls back to FP32 with a warning on some torch builds, and
        on CPU it is slower than FP32. Enabling it everywhere would put a flag in the bench table
        that did not describe what actually ran.
        """
        return self.name == "cuda"


def _probe(torch_module: object) -> str:
    cuda = getattr(torch_module, "cuda", None)
    if cuda is not None and bool(cuda.is_available()):
        return "cuda"
    backends = getattr(torch_module, "backends", None)
    mps = getattr(backends, "mps", None) if backends is not None else None
    if mps is not None and bool(mps.is_available()):
        return "mps"
    return "cpu"


def select_device(override: str | None = None, torch_module: object | None = None) -> Device:
    """Picks the inference device.

    `SAAKSHI_DEVICE` overrides detection — a deploy on a shared GPU box needs to be able to say
    `cpu` without editing code, and the bench needs to be able to measure each device separately on
    a machine that has more than one.
    """
    forced = override or os.environ.get("SAAKSHI_DEVICE")
    if forced:
        name = forced.strip().lower()
        if name not in DEVICE_PREFERENCE:
            raise ValueError(f"unknown device {name!r}; expected one of {DEVICE_PREFERENCE}")
        return Device(name=name, description=_describe(name), forced=True)

    if torch_module is None:
        import torch as torch_module  # noqa: PLC0415 — optional heavy import, deferred on purpose

    name = _probe(torch_module)
    return Device(name=name, description=_describe(name), forced=False)


def _describe(name: str) -> str:
    return {
        "cuda": "NVIDIA CUDA",
        "mps": "Apple Silicon MPS (Metal)",
        "cpu": "CPU",
    }[name]
