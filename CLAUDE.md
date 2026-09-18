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

`pnpm test` runs 87 tests against `tools/simulator` — no hardware required.

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
- **Never retry a 401/403.** A revoked token is terminal; only re-pairing fixes
  it. Retrying produces a storm against a device that will never say yes.
- **Hue is 0–360; saturation and brightness are 0–100.** Mismatched ranges are a
  classic source of wrong colours.

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
