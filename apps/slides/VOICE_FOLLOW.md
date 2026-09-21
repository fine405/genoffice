# Voice follow / text simulation

Open a PPTX in Slides, choose **Slide Show → 语音跟随**, and use the presenter sidebar.
The default input is **文字模拟** (text simulation). Enter one utterance and press
Enter or Send. Shift+Enter inserts a newline; IME confirmation does not submit.
Examples only populate the input: sending always calls the configured model.

## Models and credentials

- Jev uses `jev-1.13.0`, two independent Choice questions and the official System One API.
- DeepSeek uses `deepseek-flash` or `deepseek-v4-pro`, non-thinking mode and JSON output.
- DeepSeek reuses the app's saved provider key and endpoint. This feature does not
  change the model used by the editing assistant.
- Manage Jev and local speech recognition in **Settings → AI Model**. Jev keys
  are encrypted with Electron safeStorage in the global `ai-services.json` file.
  Earlier Jev/speech settings are preserved. Existing keys are never returned to
  the renderer. Jev also supports `TYPESAFE_API_KEY`.
- DeepSeek always reads the app's saved provider key and endpoint from
  `ai-settings.json`. Earlier sidebar keys and `DEEPSEEK_API_KEY` do not override it.
  The follow panel shows readiness only and refreshes when it regains focus.
- Compare sends the same immutable snapshot to both models. Only the selected
  controller model can move the presentation; the other is a shadow observation.

## Optional local microphone

Text simulation does not need audio permissions, Whisper or a downloaded model.
For microphone input, install whisper.cpp and download a multilingual GGML model:

```sh
brew install whisper-cpp
```

Use the [official model instructions](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md).
Select `whisper-cli` and the model's `.bin` file in **Settings → AI Model**. Do not select an
English-only `.en` model for Chinese speech. You may alternatively set
`WHISPER_CLI_PATH` and `WHISPER_MODEL_PATH` before launching the app.
The default lookup includes `/opt/homebrew/bin/whisper-cli`,
`/usr/local/bin/whisper-cli` and `~/.cache/genoffice/whisper/ggml-small.bin`.

The microphone adapter segments mono audio on silence and caps a segment at ten
seconds. It sends a 16 kHz WAV through session-scoped IPC to the local CLI. Slide
text supplies a bounded vocabulary hint. Temporary WAV and transcript files are
removed after each request. Recording starts only after Start and permission;
switching to text, closing the panel or ending the presentation releases it.
Pause keeps listening for the resume command; Close Microphone stops capture.

This first microphone implementation uses short utterance transcription, not
incremental word-level ASR. First-time Metal compilation can be slow; warm calls
are faster. Audio more than six seconds old is discarded before model/control
execution. If transcription cannot keep up, a skipped-segment notice is shown.
Do not claim the microphone meets a latency/accuracy benchmark from text results.

## Presentation control

Use full commands such as `助手，暂停跟随。`, `助手，继续跟随。`,
`助手，上一页。`, `助手，下一页。`, `助手，撤回翻页。`,
`助手，跳到第八页。`, or `助手，结束放映。` in either input mode.
Original document page numbers are used, and targets outside the playback set
are rejected. Hidden pages follow the existing presenter playback policy.

Uncertain, irrelevant, expired and preview-only judgments keep the current page.
Manual navigation pauses follow. Reset clears context and returns to the initial
page while keeping cumulative call costs. Blackout and end-of-show pause follow.
Follow displays completed slide animation states; per-bullet voice animation is
not supported. The PPTX is never edited by this feature.

The initial Jev gates (confidence 0.8, target margin 0.2), two-second dwell and
six-second decision expiry are conservative defaults, **not calibrated accuracy
claims**. Limit preparation to 1–30 slides and 24,000 serialized characters.
Long slide text/notes are visibly marked as truncated; add a short hint when
slides are visually driven or ambiguous.

## Measurement and verification

Details retain input/output/cache usage, full decision time, source, proposed
target, executed action, errors and dated tariff estimates. Missing usage or
unknown gateway prices remain unknown; cancelled requests can still be billed.
DeepSeek costs show a peak/off-peak range from the 2026-09-21 public tariff rather
than guessing holidays. Both sides of a comparison contribute to cumulative cost.
Export includes input snapshots and raw judgments; it contains no API keys or audio.
Inspect the exported slide/transcript text before sharing it externally.

`提交到结果` measures submission (or completed audio segment) to model/control
result, not the audience screen's actual paint time. No accuracy score is shown
without a labelled dataset. The comparison UI is a shadow run, not an independent
closed-loop benchmark.

```sh
npm run test -w @genoffice/slides -- voice-follow.test.ts
npm run typecheck -w @genoffice/slides
npm run build -w @genoffice/slides
npm run build -w @genoffice/shell
npx playwright test --config e2e/playwright.config.ts e2e/slides-voice-follow.spec.ts
```

The Electron test uses mock service responses in the test process only and a
scratch profile. It checks the real preload/main/renderer path, input keyboard
isolation, negation handling at the control layer, navigation, cancellation,
usage retention and source-file preservation. It is not a model quality test.
