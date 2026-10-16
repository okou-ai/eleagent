"""Select one whole frame using cheap complementary blur measurements."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Sequence

import cv2
import numpy as np


@dataclass(frozen=True)
class FrameQuality:
    laplacian_variance: float
    fft_magnitude: float


def measure_quality(image: np.ndarray, max_edge: int = 512) -> FrameQuality:
    """Score a BGR/gray frame at a bounded resolution, preserving aspect ratio."""
    if image is None or image.size == 0 or image.ndim not in (2, 3):
        raise ValueError("Expected a nonempty grayscale or BGR image")
    if max_edge < 8:
        raise ValueError("max_edge must be at least 8")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    height, width = gray.shape
    scale = min(1.0, max_edge / max(height, width))
    if scale < 1.0:
        gray = cv2.resize(
            gray,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    gray_float = gray.astype(np.float64, copy=False)
    laplacian = float(cv2.Laplacian(gray_float, cv2.CV_64F).var())
    # E²VTS's average FFT magnitude. Use ranking, not a sum of raw units.
    fft = float(np.abs(np.fft.fft2(gray_float)).mean())
    return FrameQuality(laplacian_variance=laplacian, fft_magnitude=fft)


def _ascending_ranks(values: Sequence[float]) -> list[float]:
    """Ranks start at zero; exact ties receive their mean rank."""
    return [
        sum(other < value for other in values)
        + 0.5 * (sum(other == value for other in values) - 1)
        for value in values
    ]


def select_frame(
    frames: Sequence[np.ndarray],
    positions: Sequence[float],
    *,
    max_edge: int = 512,
    duration_seconds: float | None = None,
) -> tuple[int, list[dict[str, float]]]:
    """Select one index; ranking ties prefer the frame nearest the midpoint.

    ``positions`` are fractions of one clip (normally 0.2, 0.5, 0.8).
    This measures whole-frame sharpness, not text presence or semantic value.
    """
    if not frames or len(frames) != len(positions):
        raise ValueError("Frames and positions must have matching nonzero lengths")
    if any(not 0 <= position <= 1 for position in positions):
        raise ValueError("Positions must be in [0, 1]")
    qualities = [measure_quality(frame, max_edge) for frame in frames]
    laplacian_ranks = _ascending_ranks([q.laplacian_variance for q in qualities])
    fft_ranks = _ascending_ranks([q.fft_magnitude for q in qualities])
    scores = [(lap + fft) / 2 for lap, fft in zip(laplacian_ranks, fft_ranks)]
    selected = max(
        range(len(frames)),
        key=lambda index: (scores[index], -abs(positions[index] - 0.5), -index),
    )
    details = [
        {
            **asdict(quality),
            "position": float(positions[index]),
            "rank_score": float(scores[index]),
            "quality": float(scores[index] / (len(frames) - 1)) if len(frames) > 1 else 0.5,
            "width": int(frames[index].shape[1]),
            "height": int(frames[index].shape[0]),
            **({"frame_offset_ms": round(positions[index] * duration_seconds * 1000)} if duration_seconds is not None else {}),
        }
        for index, quality in enumerate(qualities)
    ]
    return selected, details
