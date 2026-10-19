# Action Button voice conversation

Status: implementation in progress in the accompanying draft PR. This document
describes the intended behavior; it is not an announcement of a released feature.

## User experience

An iPhone shortcut opens Cindy, starts a new task on the selected available
computer, and opens the microphone after login and microphone permission.
Cindy uses its existing mobile speech recognition and task delivery, reads the
completed assistant reply with the system voice, then listens for the next turn.
Messages and replies remain in the normal task history.

The first version alternates listening and playback. A short pause after speech
submits the message; **Send now** submits immediately. **End voice conversation**
stops microphone capture and playback. It does not cancel a task already sent to
the computer. Approval requests still require the usual on-screen interaction.

Only the foreground task owns audio. Leaving it, locking the phone, or putting
Cindy in the background pauses the conversation; returning does not silently
restart the microphone. Existing unsent text must be sent or cleared before a
voice conversation begins. Restored navigation state cannot start recording.

## Set up the shortcut after installing a compatible build

1. Sign in to Cindy on the phone and computer, and confirm that the computer is
   available from the mobile app.
2. In Apple's Shortcuts app, create a shortcut with a **URL** action containing
   `cindy://voice` (Global build) or `cindycn://voice` (CN build), followed by
   **Open URLs**. Give it a memorable name, such as “Talk to Cindy”.
3. Run it once, unlock the phone if prompted, and grant microphone access.
4. On a supported iPhone, open **Settings → Action Button → Shortcut** and choose
   this shortcut. Press and hold the Action Button to run it.

The shortcut can also be launched from Shortcuts or by asking Siri to run its
name. This does not add a custom always-listening wake word or background audio.
Development builds use `cindydev://voice`.

Apple references: [Action Button shortcuts](https://support.apple.com/guide/shortcuts/run-shortcuts-with-the-action-button-apdfea15680b/ios),
[URL schemes](https://support.apple.com/guide/shortcuts/intro-to-url-schemes-apd621a1ad7a/ios),
and [running shortcuts with Siri](https://support.apple.com/guide/shortcuts/run-shortcuts-with-siri-apd07c25bb38/ios).

## Delivery and verification

System speech playback needs a native build: iOS uses `AVSpeechSynthesizer` and
Android uses `TextToSpeech`. The existing speech-recognition service and model
configuration are reused. No new TTS provider credential is required.

This changes the mobile runtime fingerprint. Older native builds must keep
ordinary dictation working and display an update prompt for voice conversation.
The feature cannot be delivered to them by an OTA update alone. Follow the
[mobile cold-update approval rules](../../../docs/dev-rules/mobile-development.md)
before merging and releasing a compatible store/TestFlight build.

Before marking the PR ready, verify cold and warm shortcut launch, signed-out
launch followed by login, microphone permission approval/denial, two complete
voice turns, ending during each phase, backgrounding/locking, interrupted audio,
offline delivery, pending approval, account/device changes, and an old native
build. Capture real iPhone UI and audio evidence; unit tests do not establish
native audio-session behavior.
