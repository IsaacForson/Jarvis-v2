# Jarvis

Personal Mac assistant. The full plan is in `Jarvis Features and Build Spec.pdf`.

## Run Jarvis

`npm start` opens the orb at the bottom right of the screen. It starts asleep: say "Hey Jarvis" (or
"Jarvis, what time is it?") to wake the male voice, or "Friday" for the female voice (the orb turns rose), then just talk.
Saying the other name hands the conversation over. "Go to sleep, Jarvis" or "Stop listening" sends it back to sleep, and so do two minutes of silence.
Needs the keys in `.env`, `brew install whisper-cpp` and the speech model in `models/` (steps below).

`npm run app` builds `~/Applications/Jarvis.app`, which runs this same folder under its own name: open it from
Spotlight or Launchpad, and macOS lists "Jarvis" (not Cursor or Terminal) under Microphone, Accessibility, Screen
Recording and Camera, to be allowed once. After code changes run `npm run build` and reopen it. Both apps are signed
with a certificate made once on this Mac (in `~/Library/Application Support/Jarvis Signing`), so macOS keeps the
permissions across rebuilds.

`npm run installer` builds `dist/Jarvis-Installer.pkg` (about 1.5 GB): a normal installer (Continue, Continue, Install)
for a standalone Jarvis.app with its code, libraries, speech models and whisper-server inside, so it needs neither this
folder nor Homebrew (Apple-silicon Macs). When it finishes, Jarvis opens a setup window that takes you through the API
keys, Microphone, Accessibility, Screen Recording, Calendar and Mail, and Camera, one button each; macOS lets no app
switch these on by itself. The installed app reads its settings from `~/Library/Application Support/Jarvis/settings.env`
(the same lines as `.env.example`). On another Mac, open the installer with right-click, Open, the first time, since
it is not signed by Apple. "Set up permissions…" in the menu-bar menu brings the setup window back.
`npm run keys-to-keychain` moves the NVIDIA and Groq keys out of `.env` into the macOS Keychain; Jarvis reads them from either.

Everyday extras: "pause", "next song" and "what is playing" press the Mac's media keys; "run my Lights off shortcut"
runs anything you have built in the Shortcuts app; "explain this" or "translate this" reads the text you have selected,
and "what I copied" reads the clipboard. "Email Dana that I am running late" or "WhatsApp Dana ..." looks the person up
in Contacts and sends through Mail, Messages or WhatsApp; every message is read back and sent only on a spoken yes,
even with `JARVIS_AUTONOMOUS=1`, and background jobs never send.

Dictation: "Jarvis, start dictation" types what you say into the app in front until you say "stop dictation".
Meeting notes: "Jarvis, take notes of this meeting" writes down everything the microphone hears, from anyone, without
answering; "Jarvis, end the meeting" saves a summary, decisions, action items and the full transcript in
`~/Documents/Meeting notes` and tells you the gist. It hears the room, so people on a call must be on the speakers.
An evening recap is given at `JARVIS_RECAP_TIME` (default 21:00) if you are at the Mac: what got done, what is open,
what is first tomorrow.

More that Jarvis does on its own and knows:
- Watching: "tell me when the download finishes", "when Dana replies", "when this price drops below 500". It looks every
  few minutes in the background (five by default, for up to a day) and tells you once.
- Routines: "when I say work mode, open Cursor and Slack and set the volume to 20". Saying the name runs it.
- Email with a date in it (a bill due, a delivery, a flight, an appointment) becomes a reminder without being asked.
- Document search: "find the contract where we agreed 650" searches inside the PDFs, Word files and notes in Documents
  and on the Desktop, by meaning. The index is built on this Mac, a few files at a time, in `library.db`.
- "Put lunch with Dana in my calendar for Friday at one" adds the event through the Calendar app.
- Developer mode: "run the tests on Jarvis", "what changed in Halo since yesterday", using the git projects under
  `~/Desktop/PROJECTS` (`JARVIS_PROJECTS_DIR` changes the folder). "What is waiting for me on GitHub?" uses `gh`.
  Slack and Jira join in when their keys are in `.env`: `SLACK_TOKEN` (a user token with search:read and chat:write),
  and `JIRA_SITE`, `JIRA_EMAIL` and `JIRA_TOKEN`.
- Eyes: "what am I holding?" takes one picture with the webcam (on for about a second) and describes it.
- Languages: "let's speak French" (or Spanish, German, Italian, Portuguese) switches what Jarvis hears and speaks, with
  a Mac voice; "back to English" returns. The spoken commands (sleep, dictation, meeting notes) stay English.

Two brains: with Groq keys (`GROQ_API_KEYS`, optional), conversation and simple actions (opening apps, volume, weather,
calendar, email, reminders, memory, screenshots, music keys, shortcuts, the clipboard) are answered by Groq, which starts replying in about half a second.
Everything else (the web, files, the screen, other apps, long jobs) is handed to the NVIDIA models, which also take over
whenever Groq is unreachable or its keys have used their minute's allowance (8,000 tokens a minute each).

- Ctrl+Option+J turns the microphone off and on.
- Ctrl+Option+S stops Jarvis talking.
- Right-click the orb to quit. Drag it to move it.

What Jarvis can do on the Mac (phase 3): open apps and web addresses, set the volume, run AppleScript, find, read and
save files in your home folder, run shell commands, look at the screen, and read your calendar and unread email from
the Calendar and Mail apps. It also browses the web in its own Chrome window (phase 6): searching, opening
pages, following links, filling in forms (dates, times and dropdowns included), comparing prices across shops and
booking. With `JARVIS_AUTONOMOUS=0` it stops on the final page and asks before it submits or books; with `1` it goes ahead. Sign in to sites yourself in that window; Jarvis never types passwords or card
details and never presses a payment button.

It can also work inside any Mac app: it reads the front window's buttons and fields, presses them, types into fields and
sends keyboard shortcuts ("open TextEdit and type ...", "work out 12 times 7 in Calculator"). It can choose commands
from an app's menu bar, and for apps that expose no controls it can find something on the screen by sight and click it,
always asking first and saying what is really under the spot. Controls that send, delete
or change something, Return in messaging apps, Command-Delete and quitting are asked about first; password fields are
never typed into. This needs Accessibility switched on, in System Settings under Privacy and Security, for the app that
launches Jarvis (Cursor or Terminal). The small Swift helper behind it is compiled by `npm run build` and needs the Xcode
command-line tools. Anything that changes or deletes something is asked about first ("Shall I ..., sir?") and
runs only on a spoken yes; `activity.log` in the data folder records exactly what was asked and done. `JARVIS_AUTONOMOUS=1` in `.env` turns
these questions off so Jarvis clicks, fills in and sends on its own; deleting is still asked about, and payments, passwords
and card numbers are still refused. Secrets (`.env`, keys, keychains)
and anything outside the home folder are off limits, and `sudo` is refused.

macOS will ask once to let the app control Calendar, Mail and other apps. Looking at the screen needs Screen Recording
switched on for the app that launches Jarvis (System Settings, Privacy and Security).

Memory (phase 4): tell Jarvis a preference or a fact about yourself, the people in your life or your projects and it
saves it for future sessions. Every conversation is kept too: "what did we say about the dentist?" or "what did we talk
about yesterday?" searches it by meaning ("my teeth" finds a talk about the dentist). "What do you remember about me?" lists the facts, and "forget everything about Dana" deletes
the matching facts and conversation lines, after asking, along with the request to forget and its reply. It all lives in `memory.db` in the app's data folder
(`~/Library/Application Support/Jarvis`), readable only by you. A copy is made each day into `backups/` there and the
last seven are kept; to go back, quit Jarvis and put a copy in place of `memory.db`.

Initiative (phase 5): Jarvis lives in the menu bar (the ◉ icon) with no Dock icon. From there you can hide the orb while
it keeps listening, switch the microphone, and tick "Start at login". It speaks up on its own:
- Reminders and alarms ("remind me at 3 to call Dana", "wake me at 7 every day"). A reminder repeats, firmer and sooner,
  until you say it is done, snooze it or drop it; an alarm repeats every minute until you answer.
- A morning briefing at `JARVIS_BRIEFING_TIME` (default 08:00): calendar, unread email, weather and reminders.
- Urgent new email (judged from sender and subject), and meetings ten minutes before they start.
- A break after 90 minutes at the Mac without one, and a word if you are still up past midnight.
- Background tasks ("in the background, compare ..."): the deep model works on it and reports when done.
- Repeating tasks ("every weekday at 8, go to my LinkedIn and apply to jobs that fit me"): run in the background at
  that time and reported. For LinkedIn, sign in once in Jarvis's own Chrome window. "What did the job do?" reads the
  results. Every job is kept on disk with the actions it has carried out: one cut short by a restart carries on
  from there instead of starting over (and is dropped if that happens three times), and a run missed while the Mac
  slept is done when it wakes (up to 12 hours late). Jobs browse in a Chrome window of their own, so you can use
  Jarvis's browser meanwhile.
- Failed GitHub Actions runs and deployments in repositories you pushed to this week (needs `gh` signed in).
- Urgent emails (judged from sender, subject and the start of the text) are followed up two hours later, and again,
  firmer each time, until you read them.

Quiet hours are 23:00 to 07:00: only alarms speak, reminders wait for the morning and email waits for the briefing.
Jarvis keeps the Mac from going to sleep on its own (the screen can still turn off), so it is always listening. If the
Mac does sleep (lid closed, or Sleep chosen), it can wake it shortly before each alarm, reminder, briefing and scheduled
task, after a one-time `npm run allow-wake` (asks for your password once; it permits only `pmset schedule wake`; undo
with `sudo rm /etc/sudoers.d/jarvis-wake`). A Mac that is shut down, or asleep with the lid closed on battery, stays
silent until it is woken.

Doing things for you: Jarvis shops (searches each item you list, picks a well-rated one, adds it to the cart, then
tells you the cart and total; you check out), plays videos and music on YouTube and other streaming sites (sign in
once in its Chrome window for paid ones), installs Mac apps with Homebrew ("install VLC"), takes screenshots (screen,
front window, or to the clipboard) and screen recordings (saved to the Desktop), scrolls whole pages, accepts cookie
banners (including ones inside frames), saves downloads to Downloads, allows or blocks a site's location,
notification, camera and microphone permissions, and can press buttons in system dialogs. It stops only where you are
needed: paying, signing in, passwords, captchas and deleting.

Hand control (phase 7): "Jarvis, turn on hand control", Ctrl+Option+H, or "Hand control" in the menu-bar menu switches
the webcam on; it is off by default and the camera is used only while it is on. Pinch thumb and index finger to grab
the hologram (the orb glows brighter), move your hand to move it, and open your hand to let go. macOS asks once to allow the camera. The hand model
(`models/hand_landmarker.task`) is downloaded by `npm run build`.

Documents: Jarvis reads Word, RTF, OpenDocument, PDF and text files, edits them in place ("change the price to 650 in
the quote on my desktop", formatting kept) and writes new ones. Before it overwrites or edits a file, the old version
goes to the Trash. PDFs are read only.

Hearing: what Jarvis said last is passed to the speech model as context, and the model is told to work out what you
meant when a word is misheard. The larger speech model (`ggml-large-v3-turbo-q5_0.bin`, download below) hears accents
and names much better, for about 0.7 s more per sentence; Jarvis uses it when it is in `models/`.
`JARVIS_WHISPER_MODEL=models/ggml-small.en.bin` in `.env` switches back to the faster small one.
Started at login, Jarvis runs as "Electron", so Accessibility and Screen Recording must be allowed for Electron too.

Voice lock: say "Jarvis, learn my voice" and then three full sentences. After that only your voice is answered.
"Forget my voice", or the right-click menu, removes the lock. The pass mark is worked out from your
three sentences and saved with the voiceprint; each check prints its match score in the log. If it turns you away too
often, say "learn my voice" again.

Orb colours: dim blue is asleep, bright blue is awake or speaking, mint is hearing you, violet is thinking, grey is microphone off, red is an error.

`JARVIS_SELFTEST=1 npx electron .` (after `npm run build`) makes Jarvis ask itself a question and answer it, then quit.
Set `JARVIS_SELFTEST_ASK="Jarvis, do I have any unread email?"` to choose the question.

## Phase 0: model speed test

Measures how fast each chosen NVIDIA model starts replying, using the API keys in turn.

1. Copy `.env.example` to `.env` and paste the keys (comma-separated). `.env` is never committed.
2. `npm install`
3. `npm run speed`

## Phase 0: voice and listening speed test

Kokoro speaks five sentences, whisper.cpp transcribes them, and the transcripts must match.

1. `brew install whisper-cpp ffmpeg`
2. Download the speech model (490 MB, English only) into `models/`, which is never committed:
   `curl -L --fail -o models/ggml-small.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin`
   and, for better hearing (550 MB):
   `curl -L --fail -o models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`
3. `npm run voice` (the first run also downloads the Kokoro voice, about 330 MB)

`npm run check` type-checks the code and runs the tests. Needs Node 24 or newer.
