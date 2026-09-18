// Model
export * from './model/types.js';
export * from './model/errors.js';
export * from './model/capabilities.js';

// HTTP
export { NanoleafClient, DEFAULT_API_PORT } from './http/client.js';
export type { NanoleafClientOptions, RequestOptions } from './http/client.js';
export { WriteQueue } from './http/write-queue.js';
export type { WriteQueueOptions } from './http/write-queue.js';

// Discovery
export { runDiscoveryLadder, DEFAULT_TIMINGS } from './discovery/ladder.js';
export type { LadderOptions, LadderTimings } from './discovery/ladder.js';
export { probeDevice, tcpReachable } from './discovery/probe.js';
export type { ProbeResult } from './discovery/probe.js';
export { browseMdns, MDNS_SERVICE_TYPES } from './discovery/mdns.js';
export { discoverSsdp } from './discovery/ssdp.js';
export { sweepSubnets, localSubnets } from './discovery/sweep.js';

// Events
export { EventStream, EventType } from './events/sse.js';
export type {
  EventStreamOptions,
  TouchEvent,
  TouchGesture,
} from './events/sse.js';

// Streaming
export { StreamController, encodeFrame, extControlRequest } from './stream/extcontrol.js';
export type { StreamSession, StreamControllerOptions } from './stream/extcontrol.js';
export { encodeFrameV1, V1_BYTES_PER_PANEL } from './stream/frame-v1.js';
export { encodeFrameV2, V2_BYTES_PER_PANEL } from './stream/frame-v2.js';

// Device
export { NanoleafDevice } from './device/device.js';
export type { DeviceOptions } from './device/device.js';
export { pairDevice, unpairDevice } from './device/pairing.js';
export type { PairOptions } from './device/pairing.js';
export {
  encodeAnimData,
  buildEffectWrite,
  buildStaticEffectWrite,
  buildSelectEffect,
  buildDeleteEffect,
  buildTempEffect,
  buildRequestAllEffects,
  buildRequestEffect,
  buildRequestPlugins,
  isNanoleafEffect,
  effectCompatibility,
  motionByUuid,
  BUILTIN_MOTIONS,
} from './device/effects.js';
export type {
  NanoleafEffect,
  PaletteColor,
  PluginOption,
  BuiltinMotion,
} from './device/effects.js';
export { toRenderLayout, streamablePanelIds, panelShapeKind } from './device/layout.js';
export type { RenderLayout, RenderPanel, LayoutBounds, PanelShapeKind } from './device/layout.js';

// Utils
export { backoffDelay, sleep } from './util/async.js';
