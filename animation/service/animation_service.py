from __future__ import annotations

import asyncio
import base64
import gc
import hashlib
import importlib
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import torch
from transformers import WhisperModel


PROJECT_ROOT = Path(__file__).resolve().parents[2]
MUSE_ROOT = PROJECT_ROOT / "animation" / "MuseTalk"
LIVE_ROOT = PROJECT_ROOT / "animation" / "LivePortrait"
RUNTIME_ROOT = Path(os.environ.get("NIGHT_VOYAGE_RUNTIME_ROOT", PROJECT_ROOT / "runtime"))
LIVE_PYTHON = RUNTIME_ROOT / "envs" / "liveportrait" / "python.exe"
FFMPEG_DIR = (
    RUNTIME_ROOT
    / "ffmpeg"
    / "ffmpeg-master-latest-win64-gpl"
    / "bin"
)
CHARACTER_ROOT = RUNTIME_ROOT / "data" / "characters"
RENDER_ROOT = RUNTIME_ROOT / "renders"
DRIVING_TEMPLATE = LIVE_ROOT / "assets" / "examples" / "driving" / "d5.pkl"
FPS = 25
SOURCE_MAX_DIM = 1664
END_PADDING_SECONDS = 0.36

EMOTION_PROFILES = {
    "neutral": ("talking.pkl", 0.38),
    "happy": ("laugh.pkl", 0.46),
    "shy": ("shy.pkl", 0.43),
    "sad": ("aggrieved.pkl", 0.44),
    "concerned": ("aggrieved.pkl", 0.27),
    "angry": ("shake_face.pkl", 0.28),
    "surprised": ("open_lip.pkl", 0.30),
}

MOTION_AMPLITUDE = {
    "neutral": 0.78,
    "happy": 1.15,
    "shy": 0.72,
    "sad": 0.48,
    "concerned": 0.60,
    "angry": 1.12,
    "surprised": 0.96,
}

for directory in (CHARACTER_ROOT, RENDER_ROOT):
    directory.mkdir(parents=True, exist_ok=True)

os.environ["PATH"] = f"{FFMPEG_DIR}{os.pathsep}{os.environ.get('PATH', '')}"
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.chdir(MUSE_ROOT)
sys.path.insert(0, str(MUSE_ROOT))


class RenderRequest(BaseModel):
    character_id: str = Field(min_length=1, max_length=120)
    image_data_url: str = Field(min_length=16)
    audio_base64: str = Field(min_length=16)
    reply_text: str = Field(default="", max_length=1200)
    emotion: str = Field(default="neutral", max_length=24)
    intensity: float = Field(default=0.4, ge=0.0, le=1.0)


class AnimationRuntime:
    def __init__(self) -> None:
        self.loaded = False
        self.loading = False
        self.realtime = None
        self.avatars: dict[str, object] = {}
        self.lock = asyncio.Lock()
        self.last_error = ""

    def load_models(self) -> None:
        if self.loaded:
            return
        self.loading = True
        started = time.perf_counter()
        try:
            realtime = importlib.import_module("scripts.realtime_inference")
            args = SimpleNamespace(
                version="v15",
                extra_margin=10,
                parsing_mode="jaw",
                audio_padding_length_left=2,
                audio_padding_length_right=2,
                skip_save_images=False,
            )
            device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
            vae, unet, pe = realtime.load_all_model(
                unet_model_path="./models/musetalkV15/unet.pth",
                vae_type="sd-vae",
                unet_config="./models/musetalkV15/musetalk.json",
                device=device,
            )
            timesteps = torch.tensor([0], device=device)
            pe = pe.half().to(device)
            vae.vae = vae.vae.half().to(device)
            unet.model = unet.model.half().to(device)

            audio_processor = realtime.AudioProcessor(
                feature_extractor_path="./models/whisper"
            )
            weight_dtype = unet.model.dtype
            whisper = WhisperModel.from_pretrained("./models/whisper")
            whisper = whisper.to(device=device, dtype=weight_dtype).eval()
            whisper.requires_grad_(False)
            face_parser = realtime.FaceParsing(
                left_cheek_width=90,
                right_cheek_width=90,
            )

            realtime.args = args
            realtime.device = device
            realtime.vae = vae
            realtime.unet = unet
            realtime.pe = pe
            realtime.timesteps = timesteps
            realtime.audio_processor = audio_processor
            realtime.weight_dtype = weight_dtype
            realtime.whisper = whisper
            realtime.fp = face_parser
            self.realtime = realtime
            self.loaded = True
            self.last_error = ""
            print(
                f"[animation] MuseTalk models loaded in "
                f"{time.perf_counter() - started:.1f}s on {device}",
                flush=True,
            )
        except Exception as error:
            self.last_error = str(error)
            raise
        finally:
            self.loading = False

    @staticmethod
    def decode_image(image_data_url: str) -> tuple[bytes, np.ndarray]:
        encoded = image_data_url.split(",", 1)[-1]
        try:
            raw = base64.b64decode(encoded, validate=True)
        except Exception as error:
            raise ValueError("角色图片不是有效的 Base64 数据") from error
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError("角色图片不能超过 16MB")
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("无法读取角色图片，请换用 JPG、PNG 或 WebP")
        height, width = image.shape[:2]
        if min(height, width) < 256:
            raise ValueError("角色图片分辨率太低，宽和高至少需要 256 像素")
        return raw, image

    @staticmethod
    def safe_character_id(character_id: str) -> str:
        cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", character_id).strip("-")
        return (cleaned or "character")[:64]

    def prepare_avatar(
        self,
        character_id: str,
        image_data_url: str,
        emotion: str,
    ) -> tuple[str, object, bool]:
        self.load_models()
        raw, image = self.decode_image(image_data_url)
        image_hash = hashlib.sha256(raw).hexdigest()[:16]
        safe_id = self.safe_character_id(character_id)
        normalized_emotion = emotion if emotion in EMOTION_PROFILES else "neutral"
        driving_name, driving_multiplier = EMOTION_PROFILES[normalized_emotion]
        driving_path = LIVE_ROOT / "assets" / "examples" / "driving" / driving_name
        avatar_id = f"{safe_id}-{image_hash}-{normalized_emotion}-hq25-v2"
        if avatar_id in self.avatars:
            return avatar_id, self.avatars[avatar_id], False

        character_dir = CHARACTER_ROOT / avatar_id
        character_dir.mkdir(parents=True, exist_ok=True)
        source_path = character_dir / f"source-{image_hash}.png"
        if not source_path.exists():
            if not cv2.imwrite(str(source_path), image):
                raise RuntimeError("无法保存角色图片")

        avatar_path = MUSE_ROOT / "results" / "v15" / "avatars" / avatar_id
        required_cache = [
            avatar_path / "latents.pt",
            avatar_path / "coords.pkl",
            avatar_path / "mask_coords.pkl",
            avatar_path / "avator_info.json",
        ]
        cache_ready = all(path.exists() for path in required_cache)

        motion_dir = character_dir / "motion"
        raw_motion_path = motion_dir / f"{source_path.stem}--{driving_path.stem}.mp4"
        motion_path = motion_dir / f"{source_path.stem}--{driving_path.stem}-25fps.mp4"
        initialized_now = False
        if not cache_ready:
            initialized_now = True
            if avatar_path.exists():
                shutil.rmtree(avatar_path, ignore_errors=True)
            if motion_dir.exists():
                shutil.rmtree(motion_dir, ignore_errors=True)
            motion_dir.mkdir(parents=True, exist_ok=True)
            command = [
                str(LIVE_PYTHON),
                str(LIVE_ROOT / "inference.py"),
                "--source",
                str(source_path),
                "--driving",
                str(driving_path),
                "--output-dir",
                str(motion_dir),
                "--driving-multiplier",
                str(driving_multiplier),
                "--source-max-dim",
                str(SOURCE_MAX_DIM),
                "--flag-normalize-lip",
            ]
            completed = subprocess.run(
                command,
                cwd=LIVE_ROOT,
                env={
                    **os.environ,
                    "PYTHONUTF8": "1",
                    "PYTHONIOENCODING": "utf-8",
                    "PATH": f"{FFMPEG_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
                },
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=180,
            )
            if completed.returncode != 0 or not raw_motion_path.exists():
                tail = (completed.stderr or completed.stdout)[-1200:]
                raise RuntimeError(f"角色动作初始化失败：{tail.strip()}")
            transcode = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-v",
                    "error",
                    "-i",
                    str(raw_motion_path),
                    "-vf",
                    f"fps={FPS}",
                    "-an",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "slow",
                    "-crf",
                    "12",
                    "-pix_fmt",
                    "yuv420p",
                    str(motion_path),
                ],
                cwd=LIVE_ROOT,
                env={
                    **os.environ,
                    "PATH": f"{FFMPEG_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
                },
                capture_output=True,
                timeout=120,
            )
            if transcode.returncode != 0 or not motion_path.exists():
                tail = transcode.stderr.decode("utf-8", errors="replace")[-1200:]
                raise RuntimeError(f"动作视频高清转码失败：{tail.strip()}")

        avatar = self.realtime.Avatar(
            avatar_id=avatar_id,
            video_path=str(motion_path),
            bbox_shift=0,
            batch_size=20,
            preparation=not cache_ready,
        )
        # A 1280px avatar cache contains hundreds of full-size frames and masks.
        # Keep only the active role in RAM so several saved roles remain safe on 16GB systems.
        self.avatars.clear()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        self.avatars[avatar_id] = avatar
        return avatar_id, avatar, initialized_now

    @staticmethod
    def pad_audio_for_natural_close(audio_path: Path, padded_path: Path) -> None:
        completed = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-i",
                str(audio_path),
                "-af",
                f"apad=pad_dur={END_PADDING_SECONDS}",
                "-ar",
                "24000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(padded_path),
            ],
            env={
                **os.environ,
                "PATH": f"{FFMPEG_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
            },
            capture_output=True,
            timeout=60,
        )
        if completed.returncode != 0 or not padded_path.exists():
            tail = completed.stderr.decode("utf-8", errors="replace")[-900:]
            raise RuntimeError(f"无法为口型添加自然收口：{tail.strip()}")

    @staticmethod
    def audio_motion_curve(audio_path: Path, frame_count: int) -> np.ndarray:
        try:
            pcm = subprocess.check_output(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-i",
                    str(audio_path),
                    "-f",
                    "s16le",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "pipe:1",
                ],
                env={
                    **os.environ,
                    "PATH": f"{FFMPEG_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
                },
                timeout=60,
            )
            samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
            samples_per_frame = max(1, int(16000 / FPS))
            energy = np.zeros(frame_count, dtype=np.float32)
            for index in range(frame_count):
                chunk = samples[
                    index * samples_per_frame : (index + 1) * samples_per_frame
                ]
                if chunk.size:
                    energy[index] = float(np.sqrt(np.mean(chunk * chunk) + 1e-8))
            reference = float(np.percentile(energy, 90)) if energy.size else 0.0
            if reference > 1e-5:
                energy = np.clip(energy / reference, 0.0, 1.25)
            if energy.size >= 5:
                energy = np.convolve(energy, np.ones(5, dtype=np.float32) / 5, mode="same")
            activity = np.zeros_like(energy)
            current = 0.0
            for index, value in enumerate(energy):
                target = 1.0 if value > 0.045 else 0.0
                rate = 0.42 if target > current else 0.26
                current += (target - current) * rate
                activity[index] = current
            return np.column_stack((energy, activity))
        except Exception:
            fallback = np.zeros((frame_count, 2), dtype=np.float32)
            fallback[:, 1] = 0.45
            return fallback

    @staticmethod
    def enhance_mouth_detail(frame: np.ndarray, bbox: object) -> np.ndarray:
        try:
            x1, y1, x2, y2 = [int(value) for value in bbox]
            if x2 <= x1 or y2 <= y1:
                return frame
            mouth_top = y1 + int((y2 - y1) * 0.50)
            mouth_bottom = min(frame.shape[0], y2)
            left = max(0, x1)
            right = min(frame.shape[1], x2)
            roi = frame[mouth_top:mouth_bottom, left:right]
            if roi.size == 0 or min(roi.shape[:2]) < 12:
                return frame
            blurred = cv2.GaussianBlur(roi, (0, 0), 1.05)
            sharpened = cv2.addWeighted(roi, 1.42, blurred, -0.42, 0)
            vertical = np.hanning(max(3, roi.shape[0])).astype(np.float32)
            horizontal = np.hanning(max(3, roi.shape[1])).astype(np.float32)
            alpha = np.outer(vertical, horizontal)[..., None] * 0.34
            blended = roi.astype(np.float32) * (1.0 - alpha) + sharpened.astype(
                np.float32
            ) * alpha
            frame[mouth_top:mouth_bottom, left:right] = np.clip(
                blended, 0, 255
            ).astype(np.uint8)
        except Exception:
            return frame
        return frame

    @staticmethod
    def blend_to_neutral_mouth(
        frame: np.ndarray,
        current_bbox: object,
        neutral_frame: np.ndarray,
        neutral_bbox: object,
        progress: float,
    ) -> np.ndarray:
        try:
            cx1, cy1, cx2, cy2 = [int(value) for value in current_bbox]
            nx1, ny1, nx2, ny2 = [int(value) for value in neutral_bbox]
            current_top = cy1 + int((cy2 - cy1) * 0.46)
            neutral_top = ny1 + int((ny2 - ny1) * 0.46)
            current_bottom = min(frame.shape[0], cy2)
            neutral_bottom = min(neutral_frame.shape[0], ny2)
            current_left, current_right = max(0, cx1), min(frame.shape[1], cx2)
            neutral_left = max(0, nx1)
            neutral_right = min(neutral_frame.shape[1], nx2)
            target = frame[current_top:current_bottom, current_left:current_right]
            neutral = neutral_frame[
                neutral_top:neutral_bottom, neutral_left:neutral_right
            ]
            if target.size == 0 or neutral.size == 0:
                return frame
            neutral = cv2.resize(
                neutral,
                (target.shape[1], target.shape[0]),
                interpolation=cv2.INTER_LANCZOS4,
            )
            vertical = np.hanning(max(3, target.shape[0])).astype(np.float32)
            horizontal = np.hanning(max(3, target.shape[1])).astype(np.float32)
            smooth_progress = progress * progress * (3.0 - 2.0 * progress)
            alpha = np.outer(vertical, horizontal)[..., None] * smooth_progress
            blended = target.astype(np.float32) * (
                1.0 - alpha
            ) + neutral.astype(np.float32) * alpha
            frame[current_top:current_bottom, current_left:current_right] = np.clip(
                blended, 0, 255
            ).astype(np.uint8)
        except Exception:
            return frame
        return frame

    def postprocess_video(
        self,
        source_path: Path,
        final_path: Path,
        padded_audio_path: Path,
        avatar: object,
        character_id: str,
        emotion: str,
        intensity: float,
    ) -> bool:
        capture = cv2.VideoCapture(str(source_path))
        if not capture.isOpened():
            raise RuntimeError("无法读取口型视频")
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        frame_count = max(1, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
        motion_curve = self.audio_motion_curve(padded_audio_path, frame_count)
        grid_y, grid_x = np.indices((height, width), dtype=np.float32)

        valid_boxes = [
            box
            for box in getattr(avatar, "coord_list_cycle", [])
            if len(box) == 4 and box[2] > box[0] and box[3] > box[1]
        ]
        if valid_boxes:
            x1, y1, x2, y2 = [float(value) for value in valid_boxes[0]]
            face_x = (x1 + x2) * 0.5
            face_y = (y1 + y2) * 0.5
        else:
            face_x, face_y = width * 0.72, height * 0.39

        body_center_x = face_x
        body_center_y = min(height * 0.77, face_y + height * 0.32)
        body_weight = np.exp(
            -(
                ((grid_x - body_center_x) / max(1.0, width * 0.27)) ** 2
                + ((grid_y - body_center_y) / max(1.0, height * 0.36)) ** 2
            )
            * 2.2
        ).astype(np.float32)
        hand_center_x = min(width * 0.91, face_x + width * 0.15)
        hand_center_y = min(height * 0.64, face_y + height * 0.06)
        hand_weight = np.exp(
            -(
                ((grid_x - hand_center_x) / max(1.0, width * 0.11)) ** 2
                + ((grid_y - hand_center_y) / max(1.0, height * 0.24)) ** 2
            )
            * 2.7
        ).astype(np.float32)

        command = [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-s:v",
            f"{width}x{height}",
            "-r",
            str(FPS),
            "-i",
            "pipe:0",
            "-i",
            str(source_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0?",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "14",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(final_path),
        ]
        encoder = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env={
                **os.environ,
                "PATH": f"{FFMPEG_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
            },
        )
        amplitude = MOTION_AMPLITUDE.get(emotion, MOTION_AMPLITUDE["neutral"])
        amplitude *= 0.68 + min(1.0, max(0.0, intensity)) * 0.55
        apply_example_b_motion = self.safe_character_id(character_id) == "example-b"
        closing_frames = max(7, int(round(END_PADDING_SECONDS * FPS)))
        avatar_frames = getattr(avatar, "frame_list_cycle", [])
        avatar_boxes = getattr(avatar, "coord_list_cycle", [])
        neutral_frame = avatar_frames[0] if avatar_frames else None
        neutral_bbox = avatar_boxes[0] if avatar_boxes else None
        index = 0
        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                energy, activity = motion_curve[min(index, len(motion_curve) - 1)]
                if apply_example_b_motion and activity > 0.01:
                    seconds = index / FPS
                    breath = math.sin(seconds * math.tau * 0.27)
                    sway = math.sin(seconds * math.tau * 0.18 + 0.7)
                    hand_sway = math.sin(seconds * math.tau * 0.46 + 1.2)
                    body_dx = sway * 1.15 * activity * amplitude
                    body_dy = (
                        breath * 1.55 + float(energy) * 1.25
                    ) * activity * amplitude
                    hand_dx = (
                        hand_sway * 1.8 + float(energy) * 2.3
                    ) * activity * amplitude
                    hand_dy = (
                        math.sin(seconds * math.tau * 0.34) * 0.9
                    ) * activity * amplitude
                    map_x = grid_x - body_weight * body_dx - hand_weight * hand_dx
                    map_y = grid_y - body_weight * body_dy - hand_weight * hand_dy
                    frame = cv2.remap(
                        frame,
                        map_x,
                        map_y,
                        interpolation=cv2.INTER_CUBIC,
                        borderMode=cv2.BORDER_REFLECT_101,
                    )
                boxes = avatar_boxes
                if (
                    boxes
                    and neutral_frame is not None
                    and neutral_bbox is not None
                    and index >= frame_count - closing_frames
                ):
                    closing_progress = (index - (frame_count - closing_frames)) / max(
                        1, closing_frames - 1
                    )
                    frame = self.blend_to_neutral_mouth(
                        frame,
                        boxes[index % len(boxes)],
                        neutral_frame,
                        neutral_bbox,
                        min(1.0, max(0.0, closing_progress)),
                    )
                if boxes:
                    frame = self.enhance_mouth_detail(
                        frame, boxes[index % len(boxes)]
                    )
                if encoder.stdin is None:
                    raise RuntimeError("高清视频编码器没有可用输入流")
                encoder.stdin.write(frame.tobytes())
                index += 1
        finally:
            capture.release()
            if encoder.stdin:
                encoder.stdin.close()
        stderr = encoder.stderr.read() if encoder.stderr else b""
        return_code = encoder.wait(timeout=180)
        if return_code != 0 or not final_path.exists():
            tail = stderr.decode("utf-8", errors="replace")[-1200:]
            raise RuntimeError(f"高清动作合成失败：{tail.strip()}")
        return True

    def render_sync(self, request: RenderRequest) -> dict[str, object]:
        started = time.perf_counter()
        emotion = request.emotion if request.emotion in EMOTION_PROFILES else "neutral"
        avatar_id, avatar, initialized_now = self.prepare_avatar(
            request.character_id,
            request.image_data_url,
            emotion,
        )
        try:
            audio_bytes = base64.b64decode(request.audio_base64, validate=True)
        except Exception as error:
            raise ValueError("回复语音不是有效的 Base64 数据") from error
        if len(audio_bytes) > 12 * 1024 * 1024:
            raise ValueError("回复语音过大")

        job_id = f"{avatar_id}-{int(time.time() * 1000)}"
        audio_path = RENDER_ROOT / f"{job_id}.mp3"
        padded_audio_path = RENDER_ROOT / f"{job_id}-padded.wav"
        audio_path.write_bytes(audio_bytes)
        self.pad_audio_for_natural_close(audio_path, padded_audio_path)
        output_name = f"reply-{int(time.time() * 1000)}"
        avatar.inference(
            str(padded_audio_path),
            output_name,
            FPS,
            False,
        )
        source_output = Path(avatar.video_out_path) / f"{output_name}.mp4"
        if not source_output.exists():
            raise RuntimeError("口型模型没有生成视频")
        final_name = f"{job_id}.mp4"
        final_path = RENDER_ROOT / final_name
        motion_enhanced = self.postprocess_video(
            source_output,
            final_path,
            padded_audio_path,
            avatar,
            request.character_id,
            emotion,
            request.intensity,
        )
        source_output.unlink(missing_ok=True)
        audio_path.unlink(missing_ok=True)
        padded_audio_path.unlink(missing_ok=True)
        elapsed = time.perf_counter() - started
        return {
            "ok": True,
            "file_name": final_name,
            "avatar_id": avatar_id,
            "initialized_now": initialized_now,
            "emotion": emotion,
            "motion_enhanced": motion_enhanced,
            "fps": FPS,
            "elapsed_seconds": round(elapsed, 1),
        }

    async def render(self, request: RenderRequest) -> dict[str, object]:
        async with self.lock:
            try:
                return await asyncio.to_thread(self.render_sync, request)
            except Exception as error:
                self.last_error = str(error)
                raise


runtime = AnimationRuntime()
app = FastAPI(title="Night Voyage Local Animation", docs_url=None, redoc_url=None)


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "ok": True,
        "model_loaded": runtime.loaded,
        "model_loading": runtime.loading,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU",
        "last_error": runtime.last_error,
    }


@app.post("/render")
async def render(request: RenderRequest) -> dict[str, object]:
    try:
        return await runtime.render(request)
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except subprocess.TimeoutExpired as error:
        raise HTTPException(status_code=504, detail="角色动画初始化超时") from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"动画生成失败：{error}") from error
