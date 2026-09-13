import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const COMMAND_TTL_MS = 10_000;

export const AppSchema = z.object({
  bundleID: z.string().min(3).max(255).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().min(1).max(120),
  running: z.boolean(),
  protected: z.boolean().default(false),
  icon: z.string().max(100_000).optional()
});

export const PermissionStateSchema = z.object({
  accessibility: z.enum(["authorized", "denied", "unknown"]),
  automation: z.enum(["authorized", "denied", "unknown"]),
  bluetooth: z.enum(["authorized", "denied", "unknown"]),
  brightness: z.enum(["available", "unavailable"])
});

export const ControlStateSchema = z.object({
  wifi: z.boolean().nullable(),
  bluetooth: z.boolean().nullable(),
  focus: z.boolean().nullable(),
  darkMode: z.boolean().nullable(),
  brightness: z.number().min(0).max(1).nullable(),
  volume: z.number().min(0).max(1).nullable(),
  muted: z.boolean().nullable()
});

export const DeviceSnapshotSchema = z.object({
  deviceID: z.string().uuid(),
  deviceName: z.string().min(1).max(120),
  online: z.boolean(),
  lastSeenAt: z.string().datetime(),
  apps: z.array(AppSchema).max(500),
  controls: ControlStateSchema,
  permissions: PermissionStateSchema,
  agentVersion: z.string().max(32),
  protocolVersion: z.literal(PROTOCOL_VERSION)
});

const BaseCommandSchema = z.object({
  id: z.string().uuid(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  elevationToken: z.string().min(32).max(256).optional()
});

const AppCommandSchema = BaseCommandSchema.extend({
  type: z.enum(["app.launch", "app.quit", "app.forceQuit"]),
  payload: z.object({ bundleID: AppSchema.shape.bundleID })
});

const ToggleCommandSchema = BaseCommandSchema.extend({
  type: z.enum(["system.wifi", "system.bluetooth", "system.focus", "system.darkMode", "system.mute"]),
  payload: z.object({ enabled: z.boolean() })
});

const LevelCommandSchema = BaseCommandSchema.extend({
  type: z.enum(["system.brightness", "system.volume"]),
  payload: z.object({ value: z.number().min(0).max(1) })
});

const ActionCommandSchema = BaseCommandSchema.extend({
  type: z.enum(["media.previous", "media.playPause", "media.next", "system.lock", "system.sleep"]),
  payload: z.object({}).strict()
});

export const CommandSchema = z.discriminatedUnion("type", [AppCommandSchema, ToggleCommandSchema, LevelCommandSchema, ActionCommandSchema]);
export type Command = z.infer<typeof CommandSchema>;
export type DeviceSnapshot = z.infer<typeof DeviceSnapshotSchema>;
export type InstalledApplication = z.infer<typeof AppSchema>;

export const highImpactTypes = new Set<Command["type"]>(["app.forceQuit", "system.lock", "system.sleep"]);
export function requiresElevation(command: Command): boolean {
  return highImpactTypes.has(command.type) || (command.type === "system.wifi" && command.payload.enabled === false);
}

export function validateFreshCommand(input: unknown, now = Date.now()): Command {
  const command = CommandSchema.parse(input);
  const issuedAt = Date.parse(command.issuedAt);
  const expiresAt = Date.parse(command.expiresAt);
  if (issuedAt > now + 5_000 || expiresAt <= now || expiresAt - issuedAt > COMMAND_TTL_MS) {
    throw new Error("COMMAND_EXPIRED");
  }
  return command;
}

export const AgentMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.authenticate"), deviceID: z.string().uuid(), signature: z.string(), timestamp: z.string().datetime() }),
  z.object({ type: z.literal("agent.snapshot"), snapshot: DeviceSnapshotSchema }),
  z.object({ type: z.literal("agent.result"), commandID: z.string().uuid(), ok: z.boolean(), code: z.string().max(80), message: z.string().max(500) })
]);

export const BrowserMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("browser.command"), deviceID: z.string().uuid(), command: CommandSchema }),
  z.object({ type: z.literal("browser.refresh"), deviceID: z.string().uuid() })
]);

export const ErrorCode = {
  Unauthorized: "UNAUTHORIZED",
  InvalidCommand: "INVALID_COMMAND",
  CommandExpired: "COMMAND_EXPIRED",
  ReplayDetected: "REPLAY_DETECTED",
  DeviceOffline: "DEVICE_OFFLINE",
  ElevationRequired: "ELEVATION_REQUIRED",
  Unsupported: "UNSUPPORTED",
  PermissionDenied: "PERMISSION_DENIED",
  ProtectedApplication: "PROTECTED_APPLICATION",
  ExecutionFailed: "EXECUTION_FAILED"
} as const;
