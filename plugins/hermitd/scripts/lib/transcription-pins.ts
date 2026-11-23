// A pin bump re-runs test-voice-engine.yml.
export const TRANSCRIPTION_PINS = {
  version: '0.3.0',
  engine: {
    'linux-x64': { url: 'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.3.0/nemo-speech-0.3.0-linux-x86_64-cpu.tar.gz', checksum: '255f12b722ab15b2a38a51cf125d56e3fa97058b528f7e895b39d6a473deb06e' },
    'linux-arm64': { url: 'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.3.0/nemo-speech-0.3.0-linux-aarch64-cpu.tar.gz', checksum: '56858eaf50d19b05902c043f65d0057352bdc107ae380c41053bfbddfc204bf1' },
    'darwin-arm64': { url: 'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.3.0/nemo-speech-0.3.0-macos-aarch64-cpu.tar.gz', checksum: '2c3a7a719b778daeb14f147e011891f16e4b2ac62388d8b8d8b365cc2eebdf15' },
  },
  ffmpeg: {
    x64: { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n9.0.1-11-ge47273f4d9-linux64-gpl-9.0.tar.xz', checksum: '182c1b509720e939bb47bfb47dc29cc0c298640401128e3dce8627d10707eb5a' },
    arm64: { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n9.0.1-11-ge47273f4d9-linuxarm64-gpl-9.0.tar.xz', checksum: 'e2dd447c8a47849c5812d87e54a47b20ae0f3603d38989440f4a5fe1af8755b1' },
  },
} as const;
