"""Sample by decoded frame number, preserving ffprobe source PTS, not seek targets."""
import json
import math
from pathlib import Path
import subprocess
import cv2


def select_frames(path: Path, directory: Path, duration: float, fps=1.0, max_frames=12):
    if not 0 < duration <= 60 or not 0 < fps <= 2:
        raise ValueError('unsupported_media_bounds')
    result = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'format=start_time:frame=best_effort_timestamp_time', '-of', 'json', str(path)],
        capture_output=True, check=True, timeout=30)
    if len(result.stdout) > 2_000_000:
        raise ValueError('frame_metadata_exceeds_bound')
    metadata = json.loads(result.stdout)
    origin = float(metadata.get('format', {}).get('start_time', '0'))
    selected = []
    last = None
    for index, frame in enumerate(metadata.get('frames', [])):
        if 'best_effort_timestamp_time' not in frame:
            raise ValueError('source_frame_pts_missing')
        offset = float(frame['best_effort_timestamp_time']) - origin
        if not math.isfinite(offset):
            raise ValueError('source_frame_pts_invalid')
        if offset < 0 or offset >= duration:
            continue
        if last is None or offset - last >= 1 / fps - 1e-6:
            selected.append((index, offset)); last = offset
        if len(selected) > 121:
            raise ValueError('frame_sample_bound_exceeded')
    if not selected:
        return []
    if not 1 <= max_frames <= 121:
        raise ValueError('frame_sample_bound_invalid')
    if len(selected) > max_frames:
        selected = [selected[round(i * (len(selected)-1) / (max_frames-1))] for i in range(max_frames)] if max_frames > 1 else selected[:1]
    expression = '+'.join(f'eq(n,{index})' for index, _ in selected)
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-i', str(path),
        '-vf', f"select='{expression}',scale=w=640:h=640:force_original_aspect_ratio=decrease",
        '-vsync', '0', '-frames:v', str(len(selected)), '-q:v', '2', '-threads', '1',
        str(directory / 'frame-%04d.jpg')], check=True, timeout=30, capture_output=True)
    outputs = sorted(directory.glob('frame-*.jpg'))
    if len(outputs) != len(selected):
        raise ValueError('decoded_frame_count_mismatch')
    frames = []
    for image, (frame_number, offset) in zip(outputs, selected):
        frame = cv2.imread(str(image))
        if frame is None:
            raise ValueError('decoded_frame_unreadable')
        frames.append((offset, frame_number, frame))
    return frames
