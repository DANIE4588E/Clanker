# Clanker

A ChatGPT-style chat app for iOS and Android (Expo + React Native) that talks to **your own endpoints**.

Supported API formats:

| Format | Example base URL |
| --- | --- |
| OpenAI-compatible | `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `http://192.168.1.10:1234/v1` (LM Studio) |
| Anthropic Messages | `https://api.anthropic.com` |
| Ollama | `http://192.168.1.10:11434` |
| Google Gemini | `https://generativelanguage.googleapis.com` |

Features: streaming replies with stop/regenerate, markdown with syntax-highlighted code blocks, image attachments for vision models, chat history drawer with search/rename/delete, model picker across all endpoints, auto-generated titles, light/dark/system theme. API keys live in the device keychain (`expo-secure-store`); chats and images are stored as files in the app's document directory.

In **Settings → Providers**, tap **Fetch models** on an endpoint or subscription to choose which new models to add. All new models start selected, and you can toggle them individually or use **Select all** or **Deselect all**. Existing models keep their effort levels, context windows, and context budget overrides.

Expand a model row to set its **Context budget**, **Max output tokens**, **Input types**, and **Reasoning levels**. Clear a token field to use its automatic value. Text is always available. Turn on Images or Videos to send that media directly to the model. Attach videos through **Files** and enable video input for a compatible model. Each reasoning level can send its own API value. Turning the reasoning control off keeps your settings and uses the provider's default effort.

A blue dot to the left of a chat title in the sidebar means a reply finished while you were away from that chat. It appears in the same spot as the spinner and clears when you view the chat again.

## Remote agent backends

**Settings → Backends** adds named **Hermes Agent** and **DeepSeek Harness** connections alongside Clanker's built-in agent. Choose the backend on an empty chat before the first message; existing chats keep their backend and remote model. Each remote chat creates and resumes its own session rather than attaching to sessions created in another application.

Remote chats support streamed replies, tool progress, approvals/clarifications, Stop, actual file uploads and downloading files the agent creates or edits. Tools run on the remote device. Follow-ups queue; regeneration is disabled to avoid repeating remote actions. The remote agent owns its memory and history; Clanker's automatic titles, suggested prompts, memory extraction and temporary-chat mode do not apply.

Install the included [companion bridge](tools/remote-bridge/README.md) on each agent device. Hermes needs its API server enabled and an upstream key. Harness needs `0.2.1-rc.5` or any later 0.2 release, stable or nightly, plus its local web server and launch token. Both agents must see the bridge's workspace directory. The linked guide includes exact Windows/POSIX setup commands, networking, retention and recovery instructions, plus optional, backed-up compatibility fixes for Hermes versions whose Runs endpoint omits streamed reasoning and usage statistics (0.22.5 through at least the current 0.23.4). The bridge works with Hermes 0.22.5 and later without a per-release update: it checks the API features Hermes reports, not its version.

Hermes models include its authenticated provider catalogue, displayed as `provider/model`, with a searchable picker on empty remote chats. In **Settings → Backends**, use **Test connection** and **Save** to refresh an existing model list. Add alternative addresses there for the same bridge's LAN, VPN or HTTPS routes; the app verifies bridge identity before changing addresses and keeps the same remote session.

Hermes and Harness chats also use the composer's effort slider and context meter, and the usual reply tokens/second and cache-hit display settings. Effort is saved per chat and frozen for submitted/queued messages. Harness supplies its exact model-specific effort choices and default; Hermes providers may clamp levels or need the bridge's per-model constraints. For Hermes, those meters need the bridge guide's optional compatibility fix while Hermes's Runs endpoint omits its native usage statistics (0.22.5 through at least 0.23.4); the fix does nothing on a Hermes that reports them itself. Harness uses its existing APIs without a source patch. Metrics appear when the backend reports them; older replies are not backfilled. Remote agents manage compression. Harness speed/cache figures cover the reply's reported model attempts; Hermes uses its native rolling/session counters.

For a new Harness Desktop device, install the standalone MIT-licensed [dsh-clanker-bridge plugin](https://github.com/danielyongzx1/dsh-clanker-bridge). It includes the bridge, generates pairing credentials locally, and follows Desktop's changing port/token through the normal shortcut; no Clanker checkout or separate Node installation is required. Existing checkout-based plugin installations remain supported and are not migrated automatically. A Windows sign-in helper can start the Hermes bridge using its persistent API key. See the bridge guide for installation and removal commands. Harness periodically reconciles saved journal data so a missed completion event cannot leave a finished turn streaming indefinitely.

Documents preserve their original bytes; photos use the existing resize behavior. Transfers are limited to 20 MB per file. Remote files have a separate versioned phone cache. Deleting a chat removes its local cache but leaves host files and sessions in place for explicit host cleanup. Project instructions are captured at chat creation; attach project files explicitly.

Checks: root `npm run test:remote`, `npm run typecheck`, `npm run lint`; bridge `npm run check` and `npm test` from `tools/remote-bridge`.

**Suggested prompts.** New chats show four conversation starters based on recent chats. **Settings → Chats → Suggested prompts** turns them off, hides cached suggestions and cancels any request in progress. When enabled, the app makes at most one generation attempt every 24 hours across all models and projects, including failed or cancelled requests. The allowance and results are saved across restarts; changing models, opening new chats or turning suggestions off and on cannot bypass the limit. Once eligible, an open empty chat or returning to one can trigger a refresh. A request already started continues when you leave the empty chat so its result can be cached.

The selected model receives titles and up to three short text excerpts from each of the five most recent eligible chats, excluding temporary and archived chats, attachments, tool output and thinking. Project chats draw from that project's chats; general chats exclude projects with project-only memory. With memory off or in a temporary chat, suggestions use no history. Cached results stay separate for each project and history setting: a context without its own cache stays empty until the app-wide allowance is available. Cached results are hidden if a source chat is deleted, archived or moved outside that context. Each suggestion shows a short summary and a matching model-selected icon; tapping it puts the full prompt in the composer for editing. Generation is a separate, tool-free request with a 20-second timeout. If it fails, previous compatible suggestions remain available; another request waits for the daily allowance.

## Agent tools

With **Settings → File & code tools** on (the default), models get tools that work on a private workspace folder on the phone. Each chat has its own workspace; chats in a project share the project's (chats from before workspaces were per chat keep the one folder they all shared):

| Tool | What it does |
| --- | --- |
| `list_files`, `search_files` | List / glob the workspace, regex-search file contents |
| `read_file` | Text and code with line numbers; images (shown to the model); text from PDF, DOCX, XLSX, PPTX, ODT/ODS/ODP and EPUB |
| `write_file`, `edit_file`, `move_path`, `delete_path` | Create, edit, move, copy and delete files |
| `run_python` | Python 3 via Pyodide (WebAssembly). Imports install themselves: python-docx, openpyxl, python-pptx, pypdf, fpdf2, pandas, matplotlib, Pillow, ... |
| `run_javascript` | JS in a Web Worker with an `fs` API over the workspace; npm libraries via `import("https://esm.sh/...")` |
| `run_shell` | Android only: `/system/bin/sh` in the workspace (the phone's built-in utilities) |
| `job_output`, `job_kill` | Collect or stop background jobs (`background: true` on the three run tools) |
| `compress`, `decompress`, `search_context`, `context_status` | Let the model manage its own context window (below) |
| `memory_save`, `memory_update`, `memory_forget` | Remember facts about the user across chats (below) |
| `search_chats`, `read_chat` | Find and read the user's earlier chats |

`write_file` and `edit_file` refuse a file the model hasn't read in this chat, or one that changed since it did, so it can't overwrite something it hasn't seen.

Background jobs run in their own worker (or shell process) while the model keeps working; their status is listed in the system prompt on every step, and the tool row in the chat updates when they finish. They don't survive an app restart.

**Context.** Each user message and each step of a reply is tagged `[mN · ~size tokens]`. The model replaces ranges it is done with by its own summaries (`compress`). It can restore them (`decompress`, one level or fully) and search the full originals (`search_context`). The originals stay in the chat; only what is sent changes. The budget is set per model on the endpoint screen (expand a model and enter something like `128K`, `1M` or `32000`). Left on auto, it is 75% of the model's context window where the API reports it (OpenRouter, Groq, LM Studio, Gemini, Anthropic), 96K on other large-context hosted APIs, and otherwise 32K. Past 90% of it the app compresses the oldest history mechanically, and if a request still overflows it compresses harder and retries. The code is in [src/lib/context.ts](src/lib/context.ts).

**Memory.** Short facts about the user (at most 500 characters each, 12,000 in all) live in **Settings → Memory**, where they can be added, edited and deleted. Each chat freezes the memories it starts with into its system prompt, so prompts keep caching; later changes reach it through the `<context>` note. Models save memories with the memory tools, and after each reply a short extra request picks up anything worth remembering (this works without tool calling and can be turned off). With **Files & code** off, chats still see their memories but can't change them. The eye button on a new chat starts a temporary chat that neither uses nor saves memories, and that `search_chats` skips. The code is in [src/lib/memory.ts](src/lib/memory.ts) and [src/store/memory.ts](src/store/memory.ts).

**Projects.** **Projects** in the sidebar groups chats that should share a workspace. Long-press a project (or use its ⋮ menu) to start a chat in it, pin it to the sidebar, rename it, change its memory or edit its instructions. A project's page lists its chats, its sources (files you add for its chats to draw on, kept in `sources/` in its workspace) and the rest of its workspace. Typing in the composer at the bottom of the page starts a chat in the project. A project's chats open over its page, with a back button to it in place of the sidebar button. Long-press a chat (in the sidebar or a project) to pin, rename, archive or delete it, or to move it into, between or out of projects: a chat moving out of its own workspace takes all its files along, and one leaving a shared workspace takes copies of the files it used. Pinned chats and projects sit in a Pinned section at the top of the sidebar. Archived chats are hidden unless **Settings → Show archived chats** is on. Its instructions go into the system prompt of every chat in it. With **project-only memory** its chats see and save only the project's own memories, and `search_chats` / `read_chat` can't cross between the project and other chats in either direction. The code is in [src/lib/projects.ts](src/lib/projects.ts) and [src/store/projects.ts](src/store/projects.ts).

For formats with no built-in reader, the model is told to write a script that handles the file. Attached files are copied into the workspace. Files the agent writes show up as chips under its reply (tap to open, long-press to share), and in **Settings → Workspace files**, which lists every workspace.

Reply text and inline visuals stay visible when **Worked for…** is collapsed. If the agent reads a workspace image without embedding it elsewhere in the reply, a preview appears where it read the image. Files handed over by the agent can be opened below the reply.

The Python and JavaScript runtimes run in a hidden WebView and load Pyodide from jsDelivr on first use (cached afterwards). The shell is a local Expo module ([modules/clanker-shell](modules/clanker-shell)), so it needs a development build; it isn't in Expo Go, and iOS can't spawn processes at all.

## Plugins

**Plugins** in the sidebar is a store of apps agents can work in: an **Installed** strip, **Popular**, **New & Noteworthy** and a section per category, with search. Tap **+** to add a plugin: it signs in (or installs at once when its account already allows it) and the row turns into **⋯** (Try in chat, details, settings, remove). Each plugin's page has prompts to try, the account it uses and its details; its settings choose whether agents may change things or only read, and list exactly what they can do. A message starting with **@Plugin** asks the agent to use it.

| Provider | Plugins | Sign-in |
| --- | --- | --- |
| Hosted MCP servers | Notion, Linear, Todoist, ClickUp, Jira & Confluence (Atlassian), Miro, Calendly, Granola, Jotform, Attio, Make, PayPal, Sentry, Supabase, Netlify, Neon, Webflow, Wix | One tap: the app registers itself with the service and signs in through the browser; no setup |
| Hosted MCP servers, no account | Hugging Face, Excalidraw, DeepWiki, Context7 | None |
| Google | Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Google Slides, Google Tasks | One Google account; adding a plugin asks only for its own access (incremental consent) |
| Microsoft | Outlook, Outlook Calendar, OneDrive, Microsoft To Do | One Microsoft account (personal or work), through Microsoft Graph |
| GitHub | GitHub | Device code (with an OAuth app) or a personal access token |
| Figma, Asana, Airtable | one each | A token from the service's settings; the connect sheet links to the page and lists the steps |
| Dropbox, Spotify | one each | Their sign-in page |
| — | Weather (Open-Meteo) | None |

**MCP plugins.** Where a service runs an official remote MCP server that lets apps register themselves (OAuth dynamic client registration) and accepts a `clanker://` redirect, the plugin uses it: [src/lib/plugins/mcp.ts](src/lib/plugins/mcp.ts) is a Streamable HTTP client (MCP 2025-06-18) that finds the server's authorization server (RFC 9728), registers (RFC 7591), signs in with PKCE naming the server as the resource (RFC 8707), refreshes tokens, and lists the server's tools. [src/lib/tools/mcp.ts](src/lib/tools/mcp.ts) offers them to the model as `<prefix>_<tool>`, with schemas narrowed to what every model provider accepts; results become text, images and workspace files (`mcp/`). Tools the server marks read-only stay on when a plugin's **Allow changes** is off. Tool lists are rechecked when Plugins opens (at most every six hours) or from a plugin's settings. Services whose MCP servers don't allow that (Google's Workspace MCP servers need your own OAuth client; GitHub, Asana, Slack and Box need pre-registered apps; Airtable, Dropbox and Monday accept only web or loopback redirects; Figma accepts only partner apps; Canva registers app redirects but its sign-in only accepts loopback ones) keep direct API integrations.

Sign-in pages open in the system browser (Chrome Custom Tabs on Android, `ASWebAuthenticationSession` on iOS, via `expo-web-browser`) and redirect back into the app with an authorization code (OAuth with PKCE, public clients, no secrets). [`src/app/+native-intent.tsx`](src/app/+native-intent.tsx) keeps those redirects from being treated as page links. GitHub's device code page and the token pages of token-based services open in the browser too. Tokens are kept in the keychain, refresh on their own, and disconnecting revokes them where the provider allows. The catalog (tools, scopes, prompts, system-prompt guidance) is [src/lib/plugins/catalog.ts](src/lib/plugins/catalog.ts); providers and their sign-in are [providers.ts](src/lib/plugins/providers.ts) and [auth.ts](src/lib/plugins/auth.ts); hand-written tools live in `src/lib/tools/{google,googleMore,microsoft,developer,productivity,media}.ts`. Only installed plugins' tools are offered; read-only plugins leave out the tools that change things; mail tools draft unless told to send; deletes go to the trash or recycle bin where the service has one. Plugins need **Files & code** on and work only with the built-in agent, not remote backends.

**OAuth clients.** MCP plugins need none. Google, Microsoft, Dropbox, Spotify and GitHub's device flow need an app registered with the provider. Build them in through `.env.local`, or let the first **+** for that provider walk through a one-time setup (steps, the exact redirect URI to register, and a field for the client ID). Google is the exception: it redirects to a scheme made from the client ID, which [app.config.js](app.config.js) registers from `EXPO_PUBLIC_GOOGLE_PLUGIN_CLIENT_ID`, so a Google client takes effect only in a build made with it.

| Variable | Register | Redirect URI |
| --- | --- | --- |
| `EXPO_PUBLIC_GOOGLE_PLUGIN_CLIENT_ID` | Google Cloud OAuth client of type **iOS** (works on Android too) with bundle ID `com.danie4588e.Clanker`; enable the Gmail, Calendar, Drive, Docs, Sheets, Slides and Tasks APIs; add test users until the app is verified | `com.googleusercontent.apps.<client id>:/oauth2redirect` (implicit for iOS clients) |
| `EXPO_PUBLIC_MICROSOFT_CLIENT_ID` | Entra app for any org + personal accounts, "Mobile and desktop applications" platform | `clanker://oauth/microsoft` |
| `EXPO_PUBLIC_DROPBOX_CLIENT_ID` | Dropbox scoped app (Full Dropbox) with the scopes in providers.ts | `clanker://oauth/dropbox` |
| `EXPO_PUBLIC_SPOTIFY_CLIENT_ID` | Spotify app (Web API) | `clanker://oauth/spotify` |
| `EXPO_PUBLIC_GITHUB_CLIENT_ID` | GitHub OAuth app with Device Flow enabled (optional; tokens work without it) | — |

The regular and preview builds share the `clanker` scheme, so with both installed Android may ask which one should finish a sign-in.

`npm run test:plugins` checks the Docs edit logic, that every catalog tool is implemented and labelled, the sign-in flows (redirects, PKCE, device code), and the MCP client against a fake server (registration, sign-in, sessions, token refresh, event streams, schemas, results).

## Run

```sh
npm install
npx expo start
```

Scan the QR code with Expo Go, then open **Settings → Add endpoint**.

For a local Ollama or LM Studio server, use your computer's LAN IP (not `localhost`) and make sure the server listens on all interfaces (`OLLAMA_HOST=0.0.0.0`). Plain-HTTP endpoints are allowed by the app config, which takes effect in development/production builds (`npx expo run:android` / `run:ios` or EAS).

## Build Android APK

Build release APKs locally and archive them in `builds/` (named after `expo.version` in `app.json`) so Gradle rebuilds don't overwrite earlier APKs: one per CPU ABI, `clanker-<version>-<abi>.apk`, plus the universal `clanker-<version>.apk`. Attach them all to a GitHub release; the in-app updater downloads the one for the phone's ABI, else the universal one.

Publish updates to [DANIE4588E/Clanker](https://github.com/DANIE4588E/Clanker/releases). To see beta releases in the app, turn on **Settings → Updates → Include pre-releases**.

```sh
npm run build:apk
```

Common flags (pass after `--`):

- `--arch arm64-v8a` – smaller, faster build of one APK for just those ABIs (no per-ABI split)
- `--out <dir>` – custom output directory (or set `CLANKER_BUILD_DIR`)
- `--install` – install the APK for the connected phone's ABI over USB via `adb install -r`
- `--skip-prebuild` / `--clean` – skip or clean `expo prebuild --platform android`
- `--overwrite` – overwrite existing APKs of the same names instead of auto-numbering (`-2`, `-3`, …)
- `--allow-debug-key` – copy APKs signed with the public debug key anyway (see below)
- `--dry-run` – preview commands and output paths without building

### Release signing

Without a release key, Gradle signs release APKs with React Native's public debug key, so anyone could sign an APK that Android accepts as a Clanker update. The build script checks every APK with `apksigner` and refuses to copy debug-signed ones unless `--allow-debug-key` is passed (meant for one final transitional release only).

Create a key once (keystores are git-ignored; keep it outside `android/`, which is regenerated):

```sh
keytool -genkeypair -v -storetype PKCS12 -keystore clanker-release.jks -alias clanker -keyalg RSA -keysize 4096 -validity 10000
```

Then add to `.env.local` (never committed):

```sh
CLANKER_RELEASE_STORE_FILE=./clanker-release.jks
CLANKER_RELEASE_KEY_ALIAS=clanker
CLANKER_RELEASE_STORE_PASSWORD='...'
CLANKER_RELEASE_KEY_PASSWORD='...'
```

The store file is relative to the project root (or absolute). With a PKCS12 keystore the key password is the store password. Quote the passwords: an unquoted `#` starts a comment.

`expo prebuild` (via `plugins/withAndroidRelease.js`) then points the release build at this key; only the path and alias go into `android/app/build.gradle`, and the passwords are read when Gradle runs (`npm run build:apk` passes them on from `.env.local`; Gradle properties of the same names work too). Without these variables, builds are signed with the debug key as before.

**Back the keystore and its passwords up somewhere safe.** Android only installs an update signed with the same key as the installed app: lose the key and existing installs can never be updated in place again.

Switching keys works the same way once: phones with a debug-signed Clanker can't install the first release-signed build over it. They have to uninstall Clanker and install the new APK (which deletes the app's data, so export anything worth keeping first); every update after that installs normally.

## Layout

- `src/app/` – routes (chat screen in a drawer, settings stack)
- `src/components/` – UI (composer, message list, markdown/code rendering, sidebar, model picker)
- `src/lib/providers/` – one adapter per API format behind a shared `ProviderAdapter` interface
- `src/lib/chat.ts` – send / stream / stop / regenerate / title generation, and the tool-calling loop
- `src/lib/tools/` – agent tool definitions, document text extraction, read-before-write tracking, the agent system prompt
- `src/lib/context.ts` – history units, compression, and building the request history
- `src/lib/jobs.ts` – background jobs
- `src/lib/runtime/` – the Python/JavaScript WebView runtime and its bridge
- `src/lib/workspace.ts` – the sandboxed workspace folders the tools work in (one per chat or project)
- `src/lib/projects.ts` – which workspace and memory a chat uses, project sources, and the project part of the system prompt
- `modules/clanker-shell/` – native Android module that runs shell commands
- `src/store/` – zustand stores persisted to JSON files

Checks: `npx tsc --noEmit` and `npx expo lint`.
