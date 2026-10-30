# odysseus-mobile

Run large language models entirely on your phone. Pick a model, download it once, and chat with it offline. Your conversations never leave the device.

## Why

This project is heavily inspired by **Odysseus** by PewDiePie, my childhood favourite YouTuber. It started with one curiosity:

> *If I can run it on a PC, why not a mobile phone too?*

This is that experiment: a local LLM chat app that fits in your pocket, built with Expo and [llama.rn](https://github.com/mybigday/llama.rn) (llama.cpp for React Native).

## Features

- **Fully on-device inference.** Models run through llama.cpp on the phone itself, and replies stream in token by token. No server, no account, no API key.
- **Hardware-aware Cookbook.** Browse the 100 trending GGUF text-generation models on Hugging Face, or search all of them. **Recommended** at the top lists the models in [Tested models](#tested-models). Filter pills narrow the list by what fits your phone, size, thinking, tool use, MoE and model family. The app reads your phone's RAM, estimates what each model needs, and greys out the ones that won't fit. Models that fit come first, smallest first. The lists are cached, so you can still browse them offline.
- **Resumable downloads.** Picks the best 4-bit file that fits your phone (`Q4_K_M` first), looking in subfolders too. It skips files that can't load on their own: vision projectors (`mmproj`), parts of split models, adapters and draft models. It asks first if the file looks too big for your RAM. Downloads show progress and can be paused, resumed or cancelled. The file size must match exactly, then the model loads automatically.
- **Load failure reports.** If a model fails to load, or crashes the app while loading, the app says what probably went wrong and offers to report it. **Report on GitHub** opens a pre-filled issue with the model, your phone, and llama.cpp's log, for you to check before submitting. **Share** sends the same report anywhere else. A model that crashed the app isn't loaded again automatically.
- **Bring your own model.** Import any `.gguf` file from your phone's storage.
- **Model library.** See your downloaded models, switch between them and delete the ones you're done with. The last model you used reloads when you open the app.
- **Chat history.** Keep multiple conversations, saved on the device.
- **Custom system prompt.** Change how the assistant behaves.
- **Thinking mode.** For models that can reason before answering (Qwen3, DeepSeek-R1 distills, gpt-oss, Gemma 4 and others), switch thinking on or off. The model's thinking streams into a collapsible block above its reply.
- **Agent mode with MCP tools.** The model can call tools through the [Model Context Protocol](https://modelcontextprotocol.io), using llama.cpp's native tool calling with each model's own chat template. Built in: file tools (in a private workspace, or a phone folder you pick) and a memory the model can save facts to. You can also connect remote MCP servers over Streamable HTTP. Tools that change something ask you first.

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

## Tested models

Models confirmed to work in the app on real phones. The Cookbook shows this table under **Recommended**, reading it straight from this README on the `master` branch, so adding a row here adds it to the app without a new release.

<!--
How the app reads this table (src/cookbook/catalog.ts, parseRecommended):
- Columns are matched by their header names, so keep the headers. Only Repo is required.
- Repo: the Hugging Face repo id, e.g. `unsloth/Qwen3-1.7B-GGUF` (a huggingface.co link works too).
- File: the exact .gguf that was tested. Leave it empty to let the app pick one.
- Features: any of thinking, tools, moe. They show as tags and work with the filter pills.
- Tested on: phone and RAM, e.g. Pixel 7 (8 GB).
Example row:
| Qwen3 1.7B | `unsloth/Qwen3-1.7B-GGUF` | `Qwen3-1.7B-Q4_K_M.gguf` | thinking, tools | Pixel 7 (8 GB) |
-->

| Model | Repo | File | Features | Tested on |
|---|---|---|---|---|

## Install

Download the latest build from the [Releases page](https://github.com/the-platapus/odysseus-mobile/releases).

- **Android (`.apk`):** open the file on your phone and allow "install unknown apps" for your browser or file manager. It's signed with the standard Expo debug key, so uninstall any copy you built with EAS first.
- **iOS (`-unsigned.ipa`):** not installable as-is. Sideload it with [Sideloadly](https://sideloadly.io) or [AltStore](https://altstore.io), which re-sign it with your Apple ID. Apps signed with a free Apple ID expire after 7 days.

## Using it

1. Tap **Cookbook** in the top-right corner.
2. On the **[DOWNLOADS]** tab, pick a model from **Recommended**, the trending list, or a search. Tap the pills to filter. Greyed-out models need more RAM than your phone has.
3. Wait for the download to finish. The model loads into memory automatically.
4. Start chatting.

Where everything else lives:

- **[MODELS]** (in the Cookbook) lists your downloaded models and has **Pick & Load Model (.gguf)** for importing your own file.
- **☰** (top left) opens your chat history and **+ New Conversation**.
- **+** (next to the message box) opens the menu with **System Prompt** and **Tools (MCP)**.
- **agent: off** (above the message box, right) switches agent mode on and off. Long-press it to open **Tools (MCP)**.
- **think: off** (next to it) switches thinking on and off. It only appears when the loaded model can think. The setting is remembered across models.

## Agent mode and MCP tools

The tool layer follows the MCP design of the Odysseus desktop app. Each MCP server's tools are offered to the model as `mcp__<server>__<tool>`. A tool that only reads runs straight away. One that changes something shows **[ALLOW]**, **[ALLOW IN CHAT]** and **[DENY]** in the chat first. You can switch each server and each tool on or off under **Tools (MCP)**.

| Server | Tools |
|---|---|
| **Built-in: Files** | `list_directory`, `read_file`, `write_file`, `edit_file`, `create_directory`, `delete_path`, `search_files` |
| **Built-in: Memory** | `manage_memory` (list, add, edit, delete, search) |
| **Remote** (added under **[ADD]**) | Whatever the server offers. It must speak MCP over Streamable HTTP. An access token is sent as a bearer token. |

- **Files** work inside the app's private workspace by default. **[FILES] → [IMPORT FILES]** copies files from your phone into it. **[PICK PHONE FOLDER]** points the tools at a real folder on the phone instead. Paths can't leave that folder.
- **Which models work:** models whose chat template supports tools (Qwen 2.5/3, Llama 3.x Instruct, Hermes and others) call tools natively. Other models with a Jinja template fall back to llama.cpp's generic JSON tool format. That works, but small models are worse at it. Models with no chat template can't use agent mode; the tools pill says so.
- **Limits:** an agent turn has up to 5 tool rounds, then the model has to answer. Each tool result is capped at 4,000 characters before the model sees it. The ■ button stops a turn.
- **Remote servers:** Android release builds only allow `https://`. A plain `http://` address (a server on your LAN, say) only works in development builds.

## Good to know

- The context window is 4,096 tokens. In normal chat, each reply is capped at 256 tokens and ends at the first blank line, so long answers get cut short.
- Normal chat prompts use a plain `User:` / `Assistant:` format instead of each model's own chat template, so some models answer better than others. Agent mode and thinking mode use the model's own chat template, and replies can run to 1,024 tokens.
- Thinking is capped at 1,024 tokens. After that the model is told to stop thinking and answer. The thinking is shown but not sent back to the model in later turns, to save context.
- RAM estimates come from the parameter count Hugging Face reports for the GGUF, or from the model's name (like `3B`) when it doesn't. Models with neither show "RAM ?".
- The internet is only used to fetch the Cookbook list, download models, and talk to any remote MCP servers you add.

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
| `src/components/CookbookMenu.js` | Hardware-aware model catalog from Hugging Face: Recommended, search, filter pills |
| `src/cookbook/` | Cookbook data: which GGUF file to download, model facts and filters, the Tested models parser |
| `src/diagnostics/` | Model load failure reports: llama.cpp log capture, crash detection, the GitHub issue |
| `src/repo.ts` | This repo's name, used for the README and for issues |
| `.github/ISSUE_TEMPLATE/model-load-failure.yml` | The issue form that load failure reports open |
| `src/hooks/useLlama.ts` | Loads models and generates replies with llama.rn, including tool-calling rounds |
| `src/hooks/useChatStore.js` | Saves conversations on the device |
| `src/hooks/useMcp.ts` | MCP settings and live server state for the UI |
| `src/mcp/` | The MCP framework: protocol, server, client, transports, `McpManager`, agent loop |
| `src/mcp/builtin/` | Built-in MCP servers (files, memory) |
| `src/mcp/expoAdapters.ts`, `src/mcp/runtime.ts` | Device storage and file access for MCP, plus the app-wide manager and its settings |
| `src/components/McpPanel.js` | The Tools (MCP) screen: servers, adding a server, the files folder |
| `src/components/ToolCallCard.js` | Tool calls and approval prompts in the chat |
| `src/components/ThinkingBlock.js` | The model's thinking above its reply |
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
