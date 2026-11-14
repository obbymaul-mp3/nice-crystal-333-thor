# Nice Crystal 333 for the AYN Thor

Build 0.1: the GRAIN room on two screens, with the native audio engine.

- Top screen: the sound, its slice, the grains, key and tempo, and a status row (sound in, keys, engine).
- Bottom screen: the round pad (position and size), PLAY / FREEZE / REVERSE / CHAOS, four sliders, four hold-throws,
  one octave of A minor, sound picker, LIVE and GRAB.
- Buttons: A play · B freeze · X reverse · Y chaos · L1 stutter · R1 half speed · L2 filter · R2 space ·
  left stick position and size · right stick pitch and density · D-pad pick and move a slider ·
  START next chaos mood · SELECT live input on or off · L3 next sound · R3 grab.
- USB-C: a class-compliant audio device is used as the input when LIVE is on; a MIDI device plays notes
  (middle C is the sound at its own pitch), with sustain pedal and pitch bend.

Not in this build yet: the deck, Crystallise, Hybrid, Vocal Shard, the library, loading your own files, recording.

## Layout
- `app/src/main/cpp/engine` — the audio engine (C++), shared with nothing else
- `app/src/main/cpp/native.cpp` — audio in and out (Oboe) and the bridge to the app
- `app/src/main/java` — the app: screens, buttons, MIDI
- `app/src/main/assets/ui` — what the two screens show
- `enginetest` — checks the C++ engine against the web engine (needs the web project next to it)
- `.github/workflows/build.yml` — builds the APK on every push and publishes it under Releases → latest
