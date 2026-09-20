# Betterleaf — working notes

Local-only Nanoleaf controller. See README.md for what it is and how to run it.
This file is for conventions that aren't obvious from the code.

## The point of the project

The official app is slow and flaky at connecting and controlling. That is the
only problem Betterleaf set out to solve, and it outranks feature count. When a
change trades responsiveness or honesty-about-state for capability, it is
probably the wrong trade.

Concretely, four things carry that weight. Don't undo them without a reason:

1. **Devices are keyed on `serialNo`, never on IP.** A DHCP lease change must not
   look like a new device or require re-pairing.
2. **Discovery races rungs concurrently**, cached address first. The UI is never
   gated on a discovery protocol answering.
3. **Writes are coalesced per property**, one request in flight per device,
   leading edge immediate. See `http/write-queue.ts`.
4. **One SSE stream per device, no polling.** Its health *is* the connection
   status. `refresh()` deliberately does not set status to connected — only the
   event stream does.

## Architecture rules

- `packages/protocol` must not import Electron or touch the DOM. It is the
  reusable core; the app is a consumer.
- **No native modules.** `bonjour-service` is pure TS; everything else is
  `node:dgram` / `node:http`. Native addons break Electron rebuilds and are the
  main thing standing between a user and the app just working.
- Workspace packages export TypeScript source (`"main": "./src/index.ts"`), not
  a build directory. Consumers bundle. This removes the "forgot to rebuild"
  failure mode; it also means anything importing the protocol package needs a TS
  loader (tsx, vite, electron-vite).
- Device differences belong in `model/capabilities.ts`, not in `if (model ===
  'NL22')` scattered through the code.

## Testing

`pnpm test` runs 202 tests against `tools/simulator` — no hardware required.

- The simulator emulates the awkward parts on purpose: 401 before pairing, an
  empty extControl body on Canvas, a Rhythm pseudo-panel in the NL22 layout,
  panel ids above 255 on the NL29.
- `tools/simulator/src/decode.ts` is written from the protocol description
  rather than by inverting the encoders. Keep it that way — an encoder checked
  against its own mirror image agrees with itself no matter how wrong it is.
- Discovery tests pass `enableMdns: false, enableSsdp: false, enableSweep: false`
  so they can't be polluted by whatever is advertising on the real network. If a
  discovery test starts failing intermittently, check for a stray `pnpm sim`.
- The frame encoder tests are pinned to byte-exact example packets from
  Nanoleaf's own documentation. If one fails, the encoder is wrong, not the test.

## Schedules

Schedules are a Betterleaf concept and run **in the app**, not on the lights.

That is forced by the hardware, not chosen. Checked against both devices:

- **NL22 Light Panels (fw 5.3.2)** has a `schedules` block in its info document
  and answers `GET /schedules` with `{"schedules":[]}`.
- **NL29 Canvas (fw 12.4.1)** 404s on every schedule path and has no such field.
  The newer firmware dropped device-side scheduling; Nanoleaf moved it to the
  cloud.

So device-native schedules would work on one of the two models and could not
express a room schedule at all. Pushing schedules down to the NL22 as a bonus is
possible later, but the app-side engine has to exist either way.

Consequences that the code depends on:

- **`setInterval` tick, never one long `setTimeout` per schedule.** An eight-hour
  timer does not survive the machine sleeping, and a lid closing is the normal
  case. Ticking also notices clock, timezone and DST changes within one tick.
- **Slots, not wall-clock instants.** A schedule records `lastRunAt` as the epoch
  ms of the *slot* it fired for. Comparing against the slot is what makes firing
  idempotent across restarts — the app reopening at 07:00:05 must not re-fire
  07:00.
- **Late is not the same as due.** Past `graceMs` (2 min) a slot is recorded as
  `missed` and skipped. Turning the lights on four hours late because the PC was
  asleep is the wrong answer, not a late right one.
- **Slots are built from local date components**, never by subtracting 24 hours,
  so "07:00" stays 07:00 across a DST boundary.
- **Single instance lock is load-bearing.** Two copies would each fire every
  schedule and race on `schedules.json`.
- **Closing the window hides to the tray.** Schedules stop when the app stops, so
  "close" must not silently mean "cancel every schedule". Quitting is explicit,
  from the tray menu.
- A firing that fails **still claims its slot**, and records why. Retrying every
  20 seconds against a light that is not there is the storm avoided everywhere
  else in this codebase.

### Locks

A locked light is **skipped by schedules entirely** — no scene, no brightness,
no power. One rule is easier to predict than a list of exceptions, and a lock
that still let a schedule dim the scene to 10% would not feel like a lock.

- **Locks are per device**, because that is where a schedule actually applies.
  A room toggle sets all its members; there is no separate room lock to drift.
- **`RoomView.locked` means *every* member**, not any. A room reading "locked"
  while a schedule could still change one of its lights would be lying.
- **Only schedules are blocked.** Manual control still works — the lock exists
  to stop the app changing the scene behind your back, not to stop you.
- **A held slot is still claimed**, and recorded as `locked`. Otherwise
  unlocking at 9am would immediately fire the 7am slot that was deliberately
  skipped. `skipped` is a third outcome in `ApplyOutcome`, deliberately neither
  success nor failure: marking it failed puts a warning on something working as
  asked, and marking it `ok` claims the lights changed when they did not.
- **Locks persist** (`locks.json`). The thing a lock defends against happens
  hours later, often after a restart.
- A room schedule **applies to the unlocked members** and reports `ok`; only an
  entirely locked room reports `locked`.

The timing rules live in `main/scheduler.ts`, which deliberately knows nothing
about devices, rooms or Electron — it decides *when* and hands the *what* to an
apply function. That is what makes the easy-to-get-subtly-wrong part testable
without hardware.

## Things that have already bitten

- **Rhythm pseudo-panel.** The NL22 reports its Rhythm module in `positionData`
  with no LEDs behind it. Include it in a frame and every subsequent panel shifts
  by one. Filtered by `isIlluminated()`.
- **Y axis.** Nanoleaf's y grows upward, screen y grows downward. Rendering raw
  values gives a vertically mirrored wall that looks plausible enough to ship.
- **`streamControlIpAddr` can be `0.0.0.0`.** Fall back to the device's API host.
- **Tearing down an SSE socket emits ECONNRESET.** Attach a sink error handler
  before `destroy()`, or it escapes as an uncaught exception. Teardown happens on
  every reconnect, so this is not an edge case.
- **`getLoginItemSettings` must be passed the same `args` as the setter.** On
  Windows it compares the stored command line against what you give it, so
  registering the login item with `--hidden` and reading it back with no args
  reports `openAtLogin: false` while the registry entry sits there plainly. The
  symptom is a "Start with Windows" checkbox that un-ticks itself the instant it
  is ticked, and a registry that says it worked. Verified by round-trip: set with
  no args reads true bare and false with args, and vice versa.
- **Never retry a 401/403.** A revoked token is terminal; only re-pairing fixes
  it. Retrying produces a storm against a device that will never say yes.
- **Hue is 0–360; saturation and brightness are 0–100.** Mismatched ranges are a
  classic source of wrong colours.

## Simulator fidelity

The simulator is only useful while it fails the way hardware fails. Two gaps
found by running the app against it, both fixed:

- **SSE keepalives.** Real controllers dribble traffic down an idle event
  stream; the client watchdog treats 60s of total silence as a wedged socket.
  A simulator that sent nothing made a quiet device flap between connected and
  reconnecting, which looked like an app bug and was not.
- **Factory effects need bodies.** `info.effects.effectsList` holds names, but
  `requestAll` must return full documents for them too. Storing only effects
  written through the API made export come back empty on a fresh device.

## Open questions for hardware

Marked `TODO(hardware)` in the source. Community sources disagree and the
hardware is the only authority:

- Whether effect writes need an explicit `"version": "2.0"` field.
- The actual `panelId`/`shapeType` the NL22 reports for its Rhythm module.
- Whether the NL29 control square is an illuminated panel (assumed yes).

## App-specific notes

- The renderer imports **types only** from `@betterleaf/protocol`. A value import
  drags `node:dgram`/`node:http` into the browser bundle and the build fails.
  Anything the UI needs computed from protocol detail (panel shape, screen
  coordinates) is computed in the main process and shipped in the snapshot.
- `packages/app` is deliberately **not** `"type": "module"` and uses
  `moduleResolution: Bundler`. Electron's main process loads CJS, and everything
  here is bundled by electron-vite, so Node's own resolution never applies.
- `ELECTRON_RUN_AS_NODE=1` in the environment (VS Code's integrated terminal sets
  it) makes Electron run as plain Node, and `require('electron')` then returns a
  path string. Symptom: `Cannot read properties of undefined (reading 'setName')`.

## Packaging

`pnpm package` (app dir) and `pnpm package:installer` (NSIS) via electron-builder,
configured in `packages/app/electron-builder.yml`.

- `@betterleaf/protocol` is in the app's **devDependencies**, not dependencies.
  electron-vite bundles it into `out/`, so it is a build-time dependency; leaving
  it under `dependencies` makes electron-builder try to ship a pnpm-symlinked
  workspace package, which it handles badly. The app ships with no runtime
  node_modules at all — `files` is just `out/**` and `package.json`.
- The icon is generated art, not a downloaded asset: `build/icon.ico` is a
  hand-packed multi-resolution ICO (16-256px). Regenerating it means re-rendering
  the PNGs and rewriting the ICO container.
- Builds are unsigned; SmartScreen warns on first run of the installer.

## Status

Phases 1 and 2 are complete and verified against the simulator: the device layer,
the simulator, the CLI, and the Electron app (discovery, pairing, control,
effects, layout preview, honest status).

Phase 3 is the interactive effect editor — painting panels on the layout canvas
with edits streaming live over UDP, then committing the result as a device-stored
static effect. The streaming engine and the `saveStaticEffect` path both exist
and are tested; what is missing is the editing UI on top of them.
