# Clanker 1.3.0-beta.8

## Reinstall once: a new signing key
- Clanker is now signed with its own release key instead of the shared development key, so nobody else can publish an update that installs over it. Because the key changed, this version can't install over an earlier one: **uninstall Clanker first**, then install this version. Uninstalling removes your chats, API keys and sign-ins.
- In-app updates now pick the download built for your phone's processor, so they're about half the size. Before installing, the app checks that a download is signed with the same key as the app you have, and refuses anything else.

## Remote backends: update the bridge
- The phone no longer sends your bridge token over the network. It signs each request with the token, and the bridge signs its replies, so a stale address or someone on the same Wi-Fi can't pick up the token or pose as your PC. Pairing is unchanged.
- **Update the bridge on each PC**: dsh-clanker-bridge 0.6.0 for Harness Desktop, hermes-clanker-bridge 0.2.0 for Hermes, or a restart for a bridge run from this repo. Older bridges show "Update the bridge" in this version, while the new bridges still work with older Clanker versions.
- The Harness plugin now works with every Harness Desktop 0.2 release (0.2.2 and later had been skipping it), and the Hermes plugin adapts to whatever the running Hermes offers rather than to one version.
- An idle remote chat no longer rewrites the chat every 750 ms while waiting. On the PC, the bridge saves less often while a reply streams, prunes turns older than 30 days and stops re-reading unchanged workspace files.

## Faster to open, smoother to use
- **Launch reads a small index instead of every chat.** A chat's messages load the first time you open it, so startup no longer slows down as your history grows. Sidebar search reads other chats in the background, and title matches appear at once.
- While a reply streams, only that reply is saved, not the whole chat. A reply cut off when the app closes still resumes on the next launch.
- **Typing no longer re-renders every message** in a long chat.
- Streaming does less work per update: long thoughts, maths, tool calls with large arguments, step lists and sources all update only what changed.
- File names in replies are checked against a cached list of the workspace instead of the file system each time. Find in chat and the usage heatmap reuse earlier work.
- Diagrams are drawn once by one shared renderer and cached, instead of each loading its own copy of Mermaid.
- Code highlighting and study cards load the first time they're needed.

## Safer by default
- Sign-ins use a secure random source for their codes and reject a return link that doesn't carry the expected state.
- When two parts of the app refresh the same plugin's token at once, the second one now reuses the refreshed token instead of failing.
- MCP sign-in only follows https addresses that belong to the server you're connecting to.
- Extra endpoint headers and plugin client secrets moved from plain settings files to the device keychain. This happens automatically on first launch.
- Scripts run in a separate runtime for each chat, so one chat's script can't see another chat's files.
- Documents, EPUBs and skill archives that would expand to an unreasonable size are refused instead of freezing the app.
- Stopping or timing out a shell command now also stops the processes it started. Typing on your behalf through phone control puts your clipboard back afterwards.
- Saving is reliable again: since Expo SDK 58, a write could finish out of order or fail silently. A chat file that can't be read is now kept aside instead of being written over.

---

# Clanker 1.3.0-beta.7

## Plan mode, the way Claude Code does it
- **/plan** now puts the chat in **plan mode** and keeps it there: replies research only (read, search, browse, ask you questions), anything that changes files, runs code, acts in apps or saves memories is refused, and a **Plan mode** chip above the box says so. `/plan <task>` starts planning that task; `/plan exit` or the chip's ✕ leaves.
- When the model has a plan it submits it with a new **exit_plan_mode** tool, which shows the plan in a card with two buttons: **Accept plan** or **Keep planning** (with a box for what to change, or just type a message). Accepting ends plan mode and **turns the plan into a goal**, so the work starts and keeps going; asking for changes sends your feedback back and the model submits a revised plan.

## Goals, developed
- Goals show above the box as a chip with the turns used (`3/20`), an **edit** button, a **pause/resume** button and a ✕. Tap it for a goal sheet showing the goal, turns used, who set it and the approved plan behind it, where you can edit, pause, resume or clear it. `/goal pause`, `/goal resume` and `/goal clear` do the same, and `/goal` alone shows how it's going.
- A goal **pauses itself** (and says why) when it reaches its limit of automatic turns, after replies with no tool calls in a row (the model is likely done or waiting on you), or when you stop a reply; your next message picks it back up. Set the **turn limit** in Settings → Tools.
- **Models can manage goals themselves**: new tools to start, edit, delete and finish goals, each with its own switch in Settings → Tools → Goals. Goals started by a model, by a plan or by you are told apart.

## Todo lists
- A new **todo_write** tool lets models keep a checklist for longer tasks. It shows above the box as a `2/5` chip with the current step; tap it for the full list, with done items struck through. Models are told the list's state through context notes, so prompts still cache.

## Smoother long chats and streaming
- Chats are now saved **one file per chat**, and only chats that changed are written, so saving while a reply streams no longer re-saves every chat on your phone. Your existing chats move over the first time anything is saved; a damaged file now loses only that one chat.
- A streaming reply updates the screen once per batch of tokens instead of up to three times, and replies that have worked for a long time no longer recompute every step, thought and site on each token.
- The fade-in of new words steps 30 times a second instead of 60, and long code blocks skip it.
- Fewer messages stay rendered off screen, and only the ones on screen glide as a reply wraps to a new line.
- The context meter no longer re-measures every tool call in the chat each second.

## Replies pick up after the app closes
- A reply that was still being written when the app was closed (or killed by your phone) now **carries on by itself** the next time you open Clanker, in place and with the chat's own model, as if you'd tapped Continue. Messages you queued behind it go out once it's done, and an active goal keeps going.
- If the app closes again before that reply finishes, it waits for you to tap Continue instead of starting over at every launch, so a reply that crashes the app can't keep crashing it.

## /compact
- **/compact** has the chat's model write a detailed summary of the conversation so far, which then **takes the place of that history** for the model, freeing up context while keeping what matters: your requests and instructions, files touched, decisions, errors and where the work stands. `/compact <focus>` tells it what to keep in most detail.
- A **Compacting** chip above the box shows while it works (✕ cancels it); messages you send meanwhile wait and go out once it's done. Your messages stay on screen, and a **Compacted · 48K → 2.1K tokens** line marks the spot; tap it to read the summary. Models can still search and restore the original messages.

## Study: quizzes, flashcards, slides, diagrams and circuits
- A new built-in **Study** plugin (Plugins → Learning, no account needed). Once added, **every chat** can draw interactive study material and diagrams right in replies:
  - **Quizzes**, one question at a time: pick an answer and it turns green or red with an explanation for each option, with a **hint** button, copy, and a final score. **Review mistakes** sends your wrong answers back to the chat to go through, or ask for a harder quiz.
  - **Flashcards**: tap to flip, sort into **Got it** and **Still learning**, shuffle, then practise the ones you missed or get quizzed on them.
  - **Slides**: a deck you page through in the chat, with speaker notes, and a button to turn it into a PowerPoint file.
  - **Diagrams**: flowcharts, sequence, state, class and ER diagrams, mind maps, timelines and more, drawn with Mermaid. Tap one to open it full screen and pinch to zoom.
  - **Circuits**: electrical schematics (resistors, capacitors, inductors, sources, diodes and LEDs, switches, lamps, meters, ground) and **logic-gate** diagrams, drawn by the app so they work offline.
- **/study** turns on **study mode** for a chat, shown by a chip above the box; `/study off` or the chip's ✕ ends it. It only changes how the model teaches: it guides you to answers instead of handing them over, teaches step by step, tests you one question at a time, helps you find your own mistakes and adapts to how you are doing. Diagrams and the rest work without it.

## Under the hood
- Plan mode, goals and todo lists are reported to the model in the per-step context note only when they change, and the system prompt only names the tools that are turned on.

---

# Clanker 1.3.0-beta.6

## Plugins: connect your apps and services
- A new **Plugins** page in the sidebar lists **40 apps** — Google Drive, Docs, Sheets, Gmail, Calendar, Microsoft 365, Notion, Linear, GitHub and more — with an Installed strip, Popular and New sections, search, categories, and a detail page with example prompts and a **Try in chat** button.
- Signing in happens in your real browser. Most apps connect through their MCP servers with **one tap**: Clanker discovers the server's sign-in, registers itself, and turns its tools into agent tools. Google, Microsoft, Dropbox and Spotify use OAuth, GitHub uses the device flow, and a few take a pasted token.
- Tools that **change** things stay off until you turn on **Allow changes** for that plugin.

## Skills, including self-improving ones
- A **Skills** tab lists your skills with switches to offer them to models, a page per skill (instructions, files, source, delete, update from source) and an editor for writing or changing one.
- Install skills in the SKILL.md format from a **GitHub repository or folder** (pick from collections like anthropics/skills), a link to a `.zip`, `.skill` or `SKILL.md`, or a file on your phone. Chats with tools list their skills and load one on demand with **skill_view**; the list is fixed per chat, so prompts still cache.
- **Self-improving skills**, after Hermes Agent: models get a skill tool to create, patch and extend skills as they work, and after a heavy reply a background review saves or fixes a skill when the task taught something reusable — noted under the reply. Can be turned off, and given its own model, in Settings → Agent.

## A Library of your files
- A **Library** in the sidebar lists every file you've attached and every file an agent made for you, across chats: grid or list, **Suggested / Favorites / All** tabs, search, type and ownership filters, multi-select, and a **Deleted** view to restore or purge.
- Tapping a file opens a preview — images, pages, code, Markdown, documents — with a box to ask about it in a new chat; holding one offers save, chat about it, share, favorite and delete.
- Agents hand finished files over with a new **present_files** tool, so helper scripts and checks stay out of your Library, and **web pages render live and usable** in chats — under the reply, where it embeds them, and as small live thumbnails in the Library.

## Google Antigravity as a subscription
- Sign in with your **Google account** in Settings → Subscriptions to chat with **Antigravity's Gemini models** through your subscription — in-app and on remote backends.
- Per-effort model variants collapse into **one model with effort levels**, and the model's **thoughts stream** live as it works.

## Edit messages and branch chats
- Editing a message or regenerating a reply now starts a **new version** of the chat from that point and keeps the old one; a "1/2" switcher on the message flips between versions.
- Any earlier reply can be **branched into a new chat**, which copies its attachments and workspace, is named "(branched)", and opens with your next prompt in the box to edit.

## Chat menu and find in chat
- The header's new-chat button becomes a **menu**: new chat, **share** (as a Markdown file), pin, add to project, uploaded files, **find in chat**, archive and delete. Find highlights the matching words in messages, replies and their code blocks, and steps through matching messages.
- The composer hides while finding in chat or typing in a text dialog, so the keyboard no longer lifts it over the dialog's backdrop.

## Answer now
- While a reply is thinking or working through tools, an **Answer now** button appears: tap it to stop the work and get a real answer from what it has found so far.

## Smaller things
- Start a new chat by **pulling up past the end** of a finished one: a ring fills as you drag, turns into a new-chat button, and the chat fades out into a fresh one with the keyboard up.
- **Memory saving is more reliable**: memory changes stay visible after history is compressed, the after-reply pass gets the previous message for context with tighter rules and per-pass caps, and runs with thinking on; pick the **model that saves memories** in Settings.
- Hyphenated model versions now read with dots (Claude Opus 5.5, Llama 3.1), and OSS stays uppercase.
- Clanker now has a **homepage, privacy policy and terms** on GitHub Pages.

---

# Clanker 1.3.0-beta.5

## Run models on your phone (experimental)
- A new **Local** provider in **Settings → Providers** runs **GGUF models on the phone itself** through llama.cpp — no server, no API key, and it keeps working offline.
- **Browse Hugging Face from the app**: search repos, filter and sort them, and pick a quantization. Split models are grouped into one, auxiliary files are skipped, and a **vision projector** can be downloaded alongside image-capable models.
- Clanker **checks free storage before downloading** and warns when a model plus its cache would be larger than — or uncomfortably close to — your phone's RAM. Downloads show progress and can be **paused and resumed, even across restarts**; an optional Hugging Face token unlocks gated repos.
- On-device models stream their replies and support **thinking, images and tool calls** (tools are off by default — the tool prompt is slow on a phone). Each model gets a **context length** slider and a **KV cache type** (F16/Q8_0/Q4_0) with a memory estimate read from the model file; one model loads at a time and requests queue behind it.
- Chats show **Loading model… N%** and **Reading prompt** while a local model warms up.

## See what you've been spending
- A new **Usage** page in the sidebar: a **year of daily activity** as a heatmap, **token totals** with the input/output split, and stats for **chats, requests, active days and cache-hit rate** over Today / 7D / 30D / 90D / All.
- A **Daily tokens** trend stacked per model — tap a day for its breakdown — and a **Breakdown by models or providers** shown as a share bar and list.
- A compact **activity calendar** now greets you on the new chat screen and opens Usage when tapped; turn it off in Settings → Appearance.

## Fixes
- The effort slider's glow is no longer cut off along its bottom edge while the keyboard is open.

---

# Clanker 1.3.0-beta.4

## Subscription usage at a glance
- The usage badge left the chat header — a **5-hour usage bar** now sits beside the attach button while the composer is expanded; tap it for a card with every limit, its reset times and a refresh button.
- The model picker shows each subscription's **plan badge** and a refresh button beside its name, **compact usage bars** instead of usage chips, and account chips carrying their 5-hour usage.
- The context meter moved left of the effort gauge, and toolbar icons are evenly spaced.

## Pick a model for background tasks
- **Generate titles** and **Suggested prompts** open their own screen in Settings where you can **assign a dedicated model** to each — a small, fast model is usually plenty — instead of always borrowing the chat's model.

## Reply detail
- A new **Reply detail** control in Settings → Appearance sets how much of the model's work shows: **Compact** — just "Working for…", tap for the steps; **Normal** — that plus the current step; **Detailed** — every step, folded away once the answer comes; **Verbose** — every step and thought, open until you fold it. Defaults to Normal.

## Settings, reorganized
- Settings is now one row per category — General, Appearance, Agent, Providers, Updates — each opening its own screen, with the row telling you what's currently set (theme, tools on, connected providers, update status).

## Smoother streaming and a livelier effort slider
- Replies **fade in token by token**, and the chat **glides upward as lines wrap** instead of jumping a frame at a time while streaming.
- The effort slider **charges up** past the everyday levels: past high, the fill turns from blue into a starry violet that streams and glows as you drag; the effort gauge matches its colours.

---

# Clanker 1.3.0-beta.3

## Fixes
- **Claude subscription chats support newer models**: Clanker refreshes its Claude Code compatibility version and retries once if Anthropic reports that a model requires a newer client.
- **Fixed an Android crash caused by malformed cookies**: provider, remote backend, and web tool requests no longer use Android's shared cookie jar.

---

# Clanker 1.3.0-beta.2

## Fixes
- **Attachment and context menus now respond reliably on Samsung and foldable devices**: moved the composer's attach menu (Camera, Photos, Files) and context usage popover out of `OverKeyboardView` into an in-window root overlay, fixing unresponsive taps on devices where separate Android overlay windows break touch hit-testing (such as Samsung Galaxy Z Fold 5, both folded and unfolded) while still keeping the keyboard open.
- Dismisses open composer popovers cleanly when the keyboard hides or the screen folds/unfolds, and tears down the attach menu immediately before launching the system camera, photo gallery or file picker.

---

# Clanker 1.3.0-beta.1

## Use your ChatGPT or Claude subscription
- Connect a **ChatGPT (Codex — Plus, Pro or Team)** or **Claude (Pro or Max)** subscription in **Settings → Subscriptions** without an API key — sign in directly or import an existing `~/.codex/auth.json` or `~/.claude/.credentials.json` login. Tokens stay in the device keychain and refresh automatically.
- Add **multiple accounts** to a subscription and pick between **Auto balance** (routes to the account with the most remaining rolling-window quota, spreads traffic evenly and cools down rate-limited accounts) and **Manual** selection.
- Live **usage cards** show remaining rolling-window capacity per account in Settings.

## Highlight and ask Clanker
- Select text smoothly **across paragraphs, lists and code blocks** in one stretch with native handles (Android; adds the `clanker-selection` native module, so it needs a new app build).
- Tap **Ask Clanker** beside Copy in the selection menu to attach the excerpt above the composer — it sends as a markdown quote with your next message, including queued and steered follow-ups.

## Clarification questions
- The built-in agent can pause mid-turn with an inline **question card** when a request needs a decision or clarification — single-choice, multi-select or open-ended. Tap an option, type your own answer in the card or straight in the composer, or skip; Clanker sends a notification if it's waiting on you while in the background.

## Continue interrupted replies
- When a reply is stopped manually, hits the tool-call round limit or fails with an error, the empty composer shows a **Continue** button (play icon) that resumes the reply in place without adding a filler user message or losing prior thoughts, tool calls and text.

## Remote backends and fixes
- Remote backend model lists are now **grouped by provider** in the model picker and backend editor, with provider-level hiding alongside per-model hiding.
- Fixed inverted chat scrolling bugs: no more jumping or drift while streaming or scrolled up, smoother nested scrolling inside long thoughts and tool outputs, chunked layout for long reasoning traces, and deferred storage writes during scrolling.

---

# Clanker 1.2.0

Everything from the four 1.2.0 betas, now stable.

## Chat with the agent on your computer
- Add a **Hermes** or **DeepSeek Harness** running on another computer as a named **remote backend**, picked before the first message and locked to that chat: the agent works there while the phone follows — progress, approvals, its questions, cancellation — and follow-ups queue. Remote chats use the agent's own memory and history, so regeneration and local helper requests are off.
- **Pair by QR code**: a bridge writes a private `pairing.html` whose code carries its addresses, token and identity, and **Scan QR code** in the backend editor fills it all in and tests the connection; rescanning a paired bridge's code updates that backend, keeping its chats, efforts and hidden models. Install the [hermes-clanker-bridge](https://github.com/danielyongzx1/hermes-clanker-bridge) plugin from Hermes's Plugins or the standalone [dsh-clanker-bridge](https://github.com/danielyongzx1/dsh-clanker-bridge) on Harness Desktop, and the pairing code shows itself. Pairing uses `expo-camera`, so it needs a new app build.
- **Switch a remote chat's model** from the chat title any time after it starts; the change applies from the next message. The eye button in the backend editor hides models from the picker, and the full model catalogue is searchable.
- Per-chat **reasoning effort** for both Hermes and Harness, and the existing meters — context usage, generation speed, cache hits — work on remote chats too.
- **Send your documents** to the remote agent and **download what it makes**, versioned, up to 20 MB per file; an open remote chat's title lists its remote files.
- Remote backends can carry several **LAN/VPN/HTTPS addresses**, probed with authenticated identity checks and safe failover; pick the backend from chips at the top of the model sheet, and manage them in their own Settings section with a dedicated editor — setup steps, a test button with a status card, a searchable default-model list.

## A new chat that starts itself
- A new chat's starter prompts are now **generated by your model**, not a fixed list, drawing on titles and excerpts from your five most recent chats — temporary and archived chats stay out of it, and project chats get starters about the project
- Tapping one drops the full prompt into the composer so you can edit before sending; the generation is a separate tool-free request to your own endpoint, and a failed or slow one just shows a retry row

## Math that renders
- TeX written as `$…$`, `$$…$$`, `\(…\)` or `\[…\]` is typeset instead of shown as source: display formulas set centered on their own line and scroll sideways when wider than the reply, inline ones sit on the sentence's baseline — rendered by MathJax, loaded the first time a reply contains math. A formula that can't be drawn shows its TeX, and one still streaming reads *Writing math…* rather than half-finished source.

## Files you can tap and recognize
- File names and paths a reply mentions — in prose, code spans or markdown links — resolve against the chat's workspace and **open with a tap**; a bare name given without its folder matches the newest file of that name.
- Chips and lists carry an **icon of the file's kind in its colour** — Word blue, Excel green, PowerPoint orange, PDF red, language logos for code — and images show a **thumbnail** of the picture itself instead of a paperclip.

## Models by name, not id
- A new **User-friendly model names** toggle in Settings, on by default, replaces provider labels and raw model ids with brand marks and tidy names — `llama-swap/qwen3.8-flash-next-mxfp4` reads as Qwen3.8 Flash Next MXFP4 under a Qwen mark — on the chat title, in the model sheet's rows and backend chips, under replies, and in the endpoints and backends lists; search still matches the raw id.
- The chat title's model selector is a single pill carrying the mark and name; a long name truncates with an ellipsis when a backend or memory icon makes it too wide.

## Smaller things and fixes
- Run in Expo Go without notifications crashing, and haptics stay silent on devices or builds without vibration instead of surfacing an error.
- On the project screen the composer no longer ends up partly under the keyboard in release builds.
- Tapping or holding selectable text in a reply no longer makes the chat jump somewhere else.
- Project and plugin links move to `danielyongzx1`; app updates are checked in both the new and the original Clanker repositories, taking the newest, so either account can publish.

---

# Clanker 1.1.2

## Updates, your way
- New **Include pre-releases** toggle in Settings → Updates: Clanker can offer beta builds, not just stable releases. Versions are now compared in proper semver order, so `1.2.0-beta.1` < `1.2.0-beta.2` < `1.2.0`
- New **Check on launch** toggle: turn off the once-a-day update probe if you'd rather only check by hand
- Flipping the pre-release toggle re-checks right away, so you're not waiting out the day for what it changes

---

# Clanker 1.1.1

## Fixes
- **Phone control now works while Clanker is in the background**: Android pauses the app's timers when you switch away, which stalled the agent mid-task in another app. It now keeps a background task alive for as long as a reply is using the phone, so the Stop overlay, waits and saves run to the end
- Phone screenshots are downsized to what the model can actually use, so looking at the screen is faster and cheaper
- **Scrolling inside replies is fixed**: dragging through a thought or tool output no longer sends the chat flying backwards at its edges — past the end, the drag now carries on into the chat the way you'd expect

---

# Clanker 1.1.0

## Clanker can use your phone
- New **phone tools**: Clanker opens apps, reads what's on screen, and taps, types, scrolls and swipes for you — filling a form or walking through another app while you watch
- Driven through an Android **accessibility service**: turn on Clanker phone control in Android's settings, then enable the tools in Settings → Tools
- The model works in small steps — open, look, act, check — and a **Stop** button stays on screen the whole time, so you can take the phone back at any moment

## Know when replies finish
- Clanker now **sends a notification when a reply finishes** while it's in the background — long agent tasks and phone control keep going after you switch away
- Tapping the notification opens that chat, even from another app or a cold start; failures are announced too, so nothing dies quietly while you're away
- Permission is asked for the first time a reply finishes, only if you've never answered, and one notification per chat replaces the last

## Updates without the browser
- Clanker checks GitHub once a day and offers to **download and install** new versions in-app (Android); watch progress in Settings → Updates, or trigger a check yourself

## Connecting
- Endpoints can list **alternative base URLs**: Clanker probes them and talks through whichever answers first — a LAN address at home, a public one elsewhere

## Smaller things
- Optional **decode speed** and **cache hit** stats under replies, averaged over the last 10 responses
- New **Generate titles** toggle in Settings
- Refreshed app icon and splash image

**Install:** download the APK below and open it. Phone control additionally needs the accessibility permission granted in Android settings.

---

# Clanker 1.0.0

The first release of Clanker: a chat app for Android that talks to your own AI endpoints instead of a single provider.

## Bring your own models
- Connect any **OpenAI-compatible** API (OpenAI, OpenRouter, LM Studio, Groq, ...), **Anthropic**, **Ollama** or **Google Gemini**
- Local servers on your network work too, including plain HTTP
- Switch models from any chat, with per-model effort levels for reasoning models
- API keys stay in the device keychain

## Chat
- Streaming replies with stop and regenerate
- Markdown with syntax-highlighted code and scrollable tables
- Image and file attachments for vision models
- Send while a reply is running: queue messages for later, or steer the reply mid-task
- Auto-generated titles, search, rename, pin, archive and delete
- Optional context meter, decode speed and cache-hit stats

## Agent tools
- A private workspace per chat for reading, writing and editing files
- Reads PDF, Word, Excel, PowerPoint, OpenDocument and EPUB files
- Runs **Python** (with pandas, matplotlib, python-docx and more) and **JavaScript** on the phone
- Runs shell commands with the phone's built-in utilities
- Web search (Firecrawl, DuckDuckGo, Exa, Brave, Tavily or SearXNG) and page reading
- Files the agent creates show up under its reply: tap to open, long-press to share

## Long chats
- Models compress their own history to stay inside the context window, and can restore it later
- Automatic compression when a chat nears its context budget, adjustable in Settings

## Memory and projects
- Clanker remembers facts about you across chats; view and edit them in Settings → Memory
- Temporary chats that don't use or save memories
- Projects group chats with a shared workspace, source files, instructions and optional project-only memory

## Install
Download `clanker-1.0.0.apk` below and open it. Android will ask you to allow installs from your browser or file manager the first time.
