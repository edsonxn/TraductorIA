# Traductor de Video IA

AI-powered video translation tool. Automatically transcribes, translates, and dubs videos into multiple languages using Google Gemini and Text-to-Speech.

## Features

- **Automatic Transcription** — Transcribes audio with Gemini 2.5 Flash, generating timestamped segments
- **Multi-language Translation** — Translates to 10 languages: Spanish, English, French, German, Portuguese, Italian, Russian, Chinese, Korean, Japanese
- **Segment-synced TTS** — Generates speech per-segment with precise timing to match the original video
- **Multiple TTS Providers** — Gemini TTS (Standard/Pro), Google Cloud Neural2, Google Cloud WaveNet, or text-only subtitles
- **Configurable Group Size** — Control how many segments are batched per TTS call (1/3/6/9/12)
- **Background Music Mixing** — Optionally mix translated audio with background music
- **Resume Support** — Resumes interrupted jobs automatically (skips already-generated segments)
- **Cost Tracking** — Tracks API costs per job with USD/MXN display and a cost dashboard
- **Electron Desktop App** — Can be packaged as a standalone Windows app

## Requirements

- **Node.js** 18+ (20+ recommended)
- **FFmpeg** installed and available in PATH (or place binaries in `ffmpeg/` folder)
- **Google API Key** — At least one Gemini API key (free tier works for most operations)
- *(Optional)* Google Cloud service account for Neural2/WaveNet TTS

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/edsonxn/TraductorIA.git
   cd TraductorIA
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file (see `.env.example`):
   ```env
   GOOGLE_API_KEY=your_gemini_api_key_here
   PORT=3001
   ```

4. Make sure FFmpeg is accessible:
   - Either install it system-wide (`ffmpeg` and `ffprobe` in PATH)
   - Or place the binaries inside the `ffmpeg/` folder

5. Start the server:
   ```bash
   npm start
   ```

6. Open `http://localhost:3001` in your browser.

## Usage

### Automatic Mode
1. Upload a video (.mp4)
2. Select target languages
3. Choose TTS provider and voice
4. Click **Generate** — the app will transcribe, translate, and generate dubbed audio files
5. Output files are saved in the `outputs/<video_name>/` folder

### Manual Mode
1. Upload a video and pre-generated audio files for each language
2. The app will mix and sync them with the original video

### Cost Dashboard
Click the **Costos** tab to view API usage costs with a daily chart, model breakdown, and USD/MXN toggle.

## Output Structure

```
outputs/<video_name>/
├── transcription.json        # Timestamped transcript
├── segments_<lang>.json      # Translated segments per language
├── script_<lang>.txt         # Full translated script
├── audio_<lang>.wav          # Final synced audio
├── <Language>.wav             # Final output (with music if provided)
├── segments_<lang>/          # Individual segment audio files
│   ├── raw_g0.wav            # Raw TTS output
│   ├── adj_g0.wav            # Speed-adjusted to match timing
│   └── gap_g0.wav            # Silence fills between segments
└── costo_<timestamp>.txt     # Cost report for this job
```

## Configuration

| Setting | Description |
|---------|-------------|
| **TTS Provider** | Gemini Standard, Gemini Pro, Cloud Neural2, Cloud WaveNet, or Text Only |
| **Group Size** | Segments per TTS call (1 = max precision, 12 = most consistent voice) |
| **Random Voice** | Randomize voice per paragraph for variety |
| **Podcast Style** | Conversational translation style with natural speech elements |
| **End Screen Seconds** | Seconds of silence to append at the end |

## Tech Stack

- **Backend**: Node.js, Express 5, ES Modules
- **Frontend**: Vanilla HTML/JS, Chart.js
- **AI**: Google Gemini (transcription, translation, TTS), Google Cloud TTS
- **Audio**: FFmpeg (extraction, speed adjustment, concatenation, mixing)
- **Desktop**: Electron (optional packaging)

## License

MIT
