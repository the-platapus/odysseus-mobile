# odysseus-mobile

Run large language models entirely on your phone. Pick a model, download it once, and chat with it offline. Your conversations never leave the device.

## Why

This project is heavily inspired by **Odysseus** by PewDiePie, my childhood favourite YouTuber. It started with one curiosity:

> *If I can run it on a PC, why not a mobile phone too?*

This is that experiment: a local LLM chat app that fits in your pocket, built with Expo and [llama.rn](https://github.com/mybigday/llama.rn) (llama.cpp for React Native).

## Features

- **Fully on-device inference.** Models run through llama.cpp on the phone itself, and replies stream in token by token. No server, no account, no API key.
- **Hardware-aware Cookbook.** Browse the 100 trending GGUF text-generation models on Hugging Face. The app reads your phone's RAM, estimates what each model needs, and greys out the ones that won't fit. Models that fit come first, smallest first. The list is cached, so you can still browse it offline.
- **Resumable downloads.** Picks the `Q4_K_M` quantisation when a repo has one (otherwise the first `.gguf` it finds), shows progress, and can pause, resume or cancel. The file size is checked when it finishes, then the model loads automatically.
- **Bring your own model.** Import any `.gguf` file from your phone's storage.
- **Model library.** See your downloaded models, switch between them and delete the ones you're done with. The last model you used reloads when you open the app.
- **Chat history.** Keep multiple conversations, saved on the device.
- **Custom system prompt.** Change how the assistant behaves.

## Requirements

- **Android** 7.0 or newer on a 64-bit phone (`arm64-v8a`). `x86_64` emulators work too.
- **iOS** 16.4 or newer, installed by sideloading (see [Install](#install)).
- **RAM** decides which models you can run. The Cookbook's rule of thumb is about 0.7 GB per billion parameters (4-bit quantised) plus 1.5 GB for the system:

  | Model size | Phone RAM needed |
  |---|---|
  | 1B | 3 GB |
  | 3B | 4 GB |
  | 7B | 7 GB |
  | 8B | 8 GB |

## Install

Download the latest build from the [Releases page](https://github.com/the-platapus/odysseus-mobile/releases).

- **Android (`.apk`):** open the file on your phone and allow "install unknown apps" for your browser or file manager. It's signed with the standard Expo debug key, so uninstall any copy you built with EAS first.
- **iOS (`-unsigned.ipa`):** not installable as-is. Sideload it with [Sideloadly](https://sideloadly.io) or [AltStore](https://altstore.io), which re-sign it with your Apple ID. Apps signed with a free Apple ID expire after 7 days.

## Using it

1. Tap **Cookbook** in the top-right corner.
2. On the **[DOWNLOADS]** tab, pick a model. Greyed-out models need more RAM than your phone has.
3. Wait for the download to finish. The model loads into memory automatically.
4. Start chatting.

Where everything else lives:

- **[MODELS]** (in the Cookbook) lists your downloaded models and has **Pick & Load Model (.gguf)** for importing your own file.
- **☰** (top left) opens your chat history and **+ New Conversation**.
- **+** (next to the message box) opens the menu with **System Prompt**.

## Good to know

- The context window is 2,048 tokens. Each reply is capped at 256 tokens and ends at the first blank line, so long answers get cut short.
- Prompts use a plain `User:` / `Assistant:` format instead of each model's own chat template, so some models answer better than others.
- RAM estimates come from the parameter count in the model's name (like `3B`). Models without one show "Unknown".
- The internet is only used to fetch the Cookbook list and download models.

## Building from source

You need Node.js 22.13 or newer. Android builds also need JDK 17 and the Android SDK; iOS builds need a Mac with Xcode 26.4 or newer.

llama.rn is a native module, so the app doesn't run in Expo Go. Install the dependencies (this also downloads llama.rn's prebuilt native files):

```bash
npm ci
```

Then build and run a development build on a connected device or emulator:

```bash
npx expo run:android
```

```bash
npx expo run:ios
```

**The first Android build takes about an hour.** On Android, llama.rn compiles llama.cpp from source once per CPU variant: 7 times for `arm64-v8a` and twice for `x86_64`. `app.config.js` limits the build to those two ABIs. iOS uses a prebuilt llama.cpp framework, so it builds in minutes.

### Release builds

**GitHub Actions.** [`.github/workflows/mobile-build.yml`](.github/workflows/mobile-build.yml) builds the Android APK and an unsigned iOS IPA, then publishes them as a GitHub Release:

- **Push to `master`:** pre-release named `build-<run number>`.
- **Push a tag like `v1.0.1`:** release named after the tag.
- **Actions → Mobile builds → Run workflow:** any branch, with iOS optional.

On a private repo, macOS minutes cost about 10x Linux minutes, so the iOS job is the expensive one.

**Locally with EAS.** EAS cloud cancels the Android build because it runs too long, so build it on your own machine instead. This needs the EAS CLI installed globally:

```bash
./build-android.sh
```

It runs `eas build --local -p android` with its temp and working directories in your home folder (the default temp space is too small for this build), logs to `build.log`, and produces an `.aab`. To turn that into an installable APK:

```bash
./wait_and_convert.sh
```

It waits for the build to finish, converts the newest `.aab` into a universal APK with bundletool, and signs it with `debug.keystore` from the project folder. Edit the `apksigner` path in the script to match your Android SDK first.

## Project structure

| Path | What it is |
|---|---|
| `App.js` | Main screen: chat, downloads, model library, history and system prompt |
| `src/components/CookbookMenu.js` | Hardware-aware model catalog from Hugging Face |
| `src/hooks/useLlama.ts` | Loads models and generates replies with llama.rn |
| `src/hooks/useChatStore.js` | Saves conversations on the device |
| `theme.json` | Colours |
| `app.config.js` | Limits Android builds to `arm64-v8a` and `x86_64` |
| `.github/workflows/mobile-build.yml` | CI builds and GitHub Releases |

## Credits

- **Odysseus** by PewDiePie, for the idea.
- [llama.cpp](https://github.com/ggml-org/llama.cpp) and [llama.rn](https://github.com/mybigday/llama.rn), which do the heavy lifting.
- [Hugging Face](https://huggingface.co) for hosting the models.
- [Expo](https://expo.dev) and React Native.

## License

MIT. See [LICENSE](LICENSE).
