export const TRANSCRIPTION_PINS = {
  version: '1.9.5-b5454',
  whisper: {
    x64: { url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz', checksum: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c' },
    arm64: { url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-arm64.tar.gz', checksum: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149' },
  },
  libgomp: {
    x64: { url: 'http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-12/libgomp1_12.3.0-1ubuntu1~22.04.3_amd64.deb', checksum: '870c27299185a5dd4accad3b15bf82a7409fd7073cccaa8025875307da4d0ce2' },
    arm64: { url: 'http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-12/libgomp1_12.3.0-1ubuntu1~22.04.3_arm64.deb', checksum: '9a1038bc9b4305ba4dfbc2c4c77a1a173a8a4e8801d32d7642a5d9a4e5fb1da7' },
  },
  ffmpeg: {
    x64: { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n9.0.1-11-ge47273f4d9-linux64-gpl-9.0.tar.xz', checksum: '182c1b509720e939bb47bfb47dc29cc0c298640401128e3dce8627d10707eb5a' },
    arm64: { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n9.0.1-11-ge47273f4d9-linuxarm64-gpl-9.0.tar.xz', checksum: 'e2dd447c8a47849c5812d87e54a47b20ae0f3603d38989440f4a5fe1af8755b1' },
  },
  models: {
    'ggml-base.bin': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin', checksum: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
    'ggml-silero-v6.2.0.bin': { url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin', checksum: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987' },
  },
} as const;
