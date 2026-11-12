"""Synthesize the entire narration of each scene, with its natural punctuation."""
import json
from pathlib import Path
import sys

from vieneu import Vieneu


folder = Path(sys.argv[1])
lines = json.loads((folder / "lines.json").read_text(encoding="utf-8"))
tts = Vieneu()
voices = {voice_id for _, voice_id in tts.list_preset_voices()}
voice = next((name for name in ("Ngọc Lan", "Trúc Ly") if name in voices), None)
(folder / "voice.txt").write_text(voice or "Giọng mặc định", encoding="utf-8")
timings = []
for index, line in enumerate(lines):
    text = " ".join(line.split())
    audio = tts.infer(text=text, voice=voice, max_chars=360, max_new_frames=620)
    if len(audio) == 0:
        raise ValueError(f"VieNeu-TTS returned no audio for scene {index + 1}")
    tts.save(audio, str(folder / f"speech-{index}.wav"))
    timings.append(len(audio) / tts.sample_rate)
(folder / "speech.json").write_text(json.dumps(timings), encoding="utf-8")
