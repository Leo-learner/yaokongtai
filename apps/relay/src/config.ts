import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RelayConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  publicOrigin: string;
  rpID: string;
  rpName: string;
  sessionSecret: string;
  bootstrapToken: string;
  databasePath: string;
  auditRetentionDays: number;
  sessionDays: number;
  agentOfflineAfterMs: number;
  webDistPath: string;
}

export function loadConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as RelayConfig["nodeEnv"];
  const sessionSecret = process.env.SESSION_SECRET ?? (nodeEnv === "production" ? "" : "local-development-secret-change-me");
  const bootstrapToken = process.env.BOOTSTRAP_TOKEN ?? (nodeEnv === "production" ? "" : "yaokongtai-local-bootstrap");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
  if (!bootstrapToken) throw new Error("BOOTSTRAP_TOKEN is required");
  return {
    nodeEnv,
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3300),
    publicOrigin: process.env.PUBLIC_ORIGIN ?? "http://localhost:3300",
    rpID: process.env.RP_ID ?? "localhost",
    rpName: process.env.RP_NAME ?? "遥控台",
    sessionSecret,
    bootstrapToken,
    databasePath: process.env.DATABASE_PATH ?? path.resolve("data/yaokongtai.sqlite"),
    auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS ?? 30),
    sessionDays: Number(process.env.SESSION_DAYS ?? 7),
    agentOfflineAfterMs: Number(process.env.AGENT_OFFLINE_AFTER_MS ?? 30_000),
    webDistPath: path.resolve(process.env.WEB_DIST_PATH ?? fileURLToPath(new URL("../../web/dist", import.meta.url))),
    ...overrides
  };
}
