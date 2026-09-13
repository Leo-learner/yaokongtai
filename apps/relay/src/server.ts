import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { AgentMessageSchema, BrowserMessageSchema, DeviceSnapshotSchema, ErrorCode, type Command, type DeviceSnapshot, requiresElevation, validateFreshCommand } from "@yaokongtai/protocol";
import { AuthService } from "./auth.js";
import { loadConfig, type RelayConfig } from "./config.js";
import { cleanupExpired, createDatabase, type DB } from "./database.js";
import { randomToken, sha256, verifyEd25519Signature } from "./crypto.js";

type Session = NonNullable<ReturnType<AuthService["sessionFromToken"]>>;
type BrowserClient = { socket: WebSocket; session: Session };
type AgentClient = { socket: WebSocket; deviceID: string; authenticated: boolean; challenge: string };
type AuditRow = { id: string; action: string; target: string | null; result: string; error_code: string | null; client_label: string; created_at: number };

export interface RelayRuntime {
  app: FastifyInstance;
  db: DB;
  config: RelayConfig;
  close: () => Promise<void>;
}

const json = (socket: WebSocket, payload: unknown) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
};

export function actionDigest(deviceID: string, command: Command) {
  return sha256(JSON.stringify({ deviceID, id: command.id, type: command.type, payload: command.payload, issuedAt: command.issuedAt, expiresAt: command.expiresAt }));
}

export async function buildServer(overrides: Partial<RelayConfig> = {}): Promise<RelayRuntime> {
  const config = loadConfig(overrides);
  const db = createDatabase(config.databasePath);
  const auth = new AuthService(db, config);
  const app = Fastify({ logger: config.nodeEnv !== "test", trustProxy: config.nodeEnv === "production" });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      if (config.nodeEnv === "production" && origin !== config.publicOrigin) return reply.code(403).send({ error: "ORIGIN_REJECTED" });
      if (origin && origin !== config.publicOrigin) return reply.code(403).send({ error: "ORIGIN_REJECTED" });
    }
  });

  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<Session | null> => {
    const session = auth.sessionFromRequest(request);
    if (!session) { await reply.code(401).send({ error: ErrorCode.Unauthorized }); return null; }
    return session;
  };

  app.get("/healthz", async () => ({ ok: true, protocolVersion: 1 }));
  app.get("/api/config", async () => ({ hasAdmin: auth.hasAdmin(), rpID: config.rpID, rpName: config.rpName, productionOrigin: "https://control.dkz12345.com" }));

  app.post<{ Body: { token: string; username?: string } }>("/api/auth/bootstrap/options", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (request, reply) => {
    try { return await auth.bootstrapOptions(request.body.token, request.body.username?.trim() || "Leo"); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "BOOTSTRAP_FAILED" }); }
  });
  app.post<{ Body: { flowID: string; response: RegistrationResponseJSON } }>("/api/auth/bootstrap/verify", async (request, reply) => {
    try {
      const result = await auth.bootstrapVerify(request.body.flowID, request.body.response);
      auth.setSessionCookie(reply, result.sessionToken);
      return { recoveryCodes: result.recoveryCodes };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "BOOTSTRAP_FAILED" }); }
  });
  app.post("/api/auth/login/options", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (_request, reply) => {
    try { return await auth.loginOptions(); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "LOGIN_FAILED" }); }
  });
  app.post<{ Body: { flowID: string; response: AuthenticationResponseJSON } }>("/api/auth/login/verify", async (request, reply) => {
    try {
      const result = await auth.loginVerify(request.body.flowID, request.body.response);
      auth.setSessionCookie(reply, result.sessionToken);
      return { ok: true };
    } catch (error) { return reply.code(401).send({ error: error instanceof Error ? error.message : "LOGIN_FAILED" }); }
  });
  app.post<{ Body: { code: string } }>("/api/auth/recover", { config: { rateLimit: { max: 5, timeWindow: "30 minutes" } } }, async (request, reply) => {
    try {
      const result = auth.recover(request.body.code.trim().toUpperCase());
      auth.setSessionCookie(reply, result.sessionToken);
      return { ok: true, expiresIn: 600 };
    } catch (error) { return reply.code(401).send({ error: error instanceof Error ? error.message : "RECOVERY_FAILED" }); }
  });
  app.post("/api/auth/passkey/options", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    try { return await auth.addPasskeyOptions(session); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "PASSKEY_OPTIONS_FAILED" }); }
  });
  app.post<{ Body: { flowID: string; response: RegistrationResponseJSON } }>("/api/auth/passkey/verify", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    try { await auth.addPasskeyVerify(session, request.body.flowID, request.body.response); return { ok: true }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "PASSKEY_VERIFY_FAILED" }); }
  });
  app.post("/api/auth/logout", async (request, reply) => { auth.logout(request, reply); return { ok: true }; });
  app.get("/api/me", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    const admin = db.prepare("SELECT username FROM admins WHERE id=?").get(session.admin_id) as { username: string };
    return { username: admin.username, sessionExpiresAt: new Date(session.expires_at).toISOString() };
  });

  app.post<{ Body: { deviceID: string; command: unknown } }>("/api/auth/elevation/options", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    try {
      const command = validateFreshCommand(request.body.command);
      if (!requiresElevation(command)) return reply.code(400).send({ error: "ELEVATION_NOT_REQUIRED" });
      return await auth.elevationOptions(session, actionDigest(request.body.deviceID, command));
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : ErrorCode.InvalidCommand }); }
  });
  app.post<{ Body: { flowID: string; response: AuthenticationResponseJSON } }>("/api/auth/elevation/verify", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    try { return { elevationToken: await auth.elevationVerify(session, request.body.flowID, request.body.response) }; }
    catch (error) { return reply.code(401).send({ error: error instanceof Error ? error.message : "ELEVATION_FAILED" }); }
  });

  app.post("/api/pairings", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    const code = randomToken(6).replace(/[-_]/g, "A").slice(0, 8).toUpperCase();
    db.prepare("INSERT INTO pairings(id,code_hash,expires_at) VALUES(?,?,?)").run(crypto.randomUUID(), sha256(code), Date.now() + 10 * 60_000);
    return { code, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  });
  app.post<{ Body: { code: string; deviceName: string; publicKey: string } }>("/api/agent/enroll", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const { code, deviceName, publicKey } = request.body;
    if (!/^[A-Za-z0-9+/]{40,}={0,2}$/.test(publicKey) || !deviceName?.trim()) return reply.code(400).send({ error: "INVALID_ENROLLMENT" });
    const pairing = db.prepare("SELECT id,expires_at,used_at FROM pairings WHERE code_hash=?").get(sha256(code.trim().toUpperCase())) as { id: string; expires_at: number; used_at: number | null } | undefined;
    if (!pairing || pairing.used_at || pairing.expires_at < Date.now()) return reply.code(401).send({ error: "INVALID_PAIRING_CODE" });
    const deviceID = crypto.randomUUID();
    db.transaction(() => {
      db.prepare("UPDATE pairings SET used_at=? WHERE id=?").run(Date.now(), pairing.id);
      db.prepare("INSERT INTO devices(id,name,public_key,created_at) VALUES(?,?,?,?)").run(deviceID, deviceName.trim().slice(0, 120), publicKey, Date.now());
    })();
    return { deviceID, websocketURL: `${config.publicOrigin.replace(/^http/, "ws")}/ws/agent?deviceID=${deviceID}` };
  });

  const snapshots = new Map<string, DeviceSnapshot>();
  const agentClients = new Map<string, AgentClient>();
  const browserClients = new Set<BrowserClient>();
  const tickets = new Map<string, { session: Session; expiresAt: number }>();
  const pendingCommands = new Map<string, { auditID: string; deviceID: string; expiresAt: number }>();
  const failPending = (commandID: string, code: string, message: string) => {
    const pending = pendingCommands.get(commandID);
    if (!pending) return;
    pendingCommands.delete(commandID);
    db.prepare("UPDATE audit_events SET result='failed',error_code=? WHERE id=?").run(code, pending.auditID);
    for (const client of browserClients) json(client.socket, { type: "command.result", commandID, ok: false, code, message });
  };

  app.get("/api/devices", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    const rows = db.prepare("SELECT id,name,last_seen_at FROM devices ORDER BY created_at").all() as { id: string; name: string; last_seen_at: number | null }[];
    return rows.map((row) => snapshots.get(row.id) ?? { deviceID: row.id, deviceName: row.name, online: false, lastSeenAt: new Date(row.last_seen_at ?? 0).toISOString(), apps: [], controls: { wifi: null, bluetooth: null, focus: null, darkMode: null, brightness: null, volume: null, muted: null }, permissions: { accessibility: "unknown", automation: "unknown", bluetooth: "unknown", brightness: "unavailable" }, agentVersion: "unknown", protocolVersion: 1 });
  });
  app.get<{ Params: { deviceID: string } }>("/api/devices/:deviceID", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    const snapshot = snapshots.get(request.params.deviceID);
    if (snapshot) return snapshot;
    const row = db.prepare("SELECT id,name,last_seen_at FROM devices WHERE id=?").get(request.params.deviceID) as { id: string; name: string; last_seen_at: number | null } | undefined;
    if (!row) return reply.code(404).send({ error: "DEVICE_NOT_FOUND" });
    return { deviceID: row.id, deviceName: row.name, online: false, lastSeenAt: new Date(row.last_seen_at ?? 0).toISOString(), apps: [], controls: { wifi: null, bluetooth: null, focus: null, darkMode: null, brightness: null, volume: null, muted: null }, permissions: { accessibility: "unknown", automation: "unknown", bluetooth: "unknown", brightness: "unavailable" }, agentVersion: "unknown", protocolVersion: 1 };
  });
  app.get<{ Params: { deviceID: string } }>("/api/devices/:deviceID/favorites", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    return db.prepare("SELECT bundle_id AS bundleID FROM favorites WHERE admin_id=? AND device_id=? ORDER BY position").all(session.admin_id, request.params.deviceID);
  });
  app.put<{ Params: { deviceID: string }; Body: { bundleIDs: string[] } }>("/api/devices/:deviceID/favorites", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    const available = new Set((snapshots.get(request.params.deviceID)?.apps ?? []).map((app) => app.bundleID));
    const ids = [...new Set(request.body.bundleIDs)].slice(0, 12);
    if (ids.some((id) => !available.has(id))) return reply.code(400).send({ error: "UNKNOWN_APPLICATION" });
    db.transaction(() => {
      db.prepare("DELETE FROM favorites WHERE admin_id=? AND device_id=?").run(session.admin_id, request.params.deviceID);
      const insert = db.prepare("INSERT INTO favorites(admin_id,device_id,bundle_id,position) VALUES(?,?,?,?)");
      ids.forEach((id, index) => insert.run(session.admin_id, request.params.deviceID, id, index));
    })();
    return { ok: true };
  });
  app.get("/api/audit", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    const rows = db.prepare("SELECT id,action,target,result,error_code,client_label,created_at FROM audit_events WHERE admin_id=? ORDER BY created_at DESC LIMIT 200").all(session.admin_id) as AuditRow[];
    return rows.map((row) => ({ ...row, createdAt: new Date(row.created_at).toISOString() }));
  });
  app.post("/api/ws-ticket", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    const ticket = randomToken(24);
    tickets.set(ticket, { session, expiresAt: Date.now() + 30_000 });
    return { ticket, expiresIn: 30 };
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", config.publicOrigin);
    if (!["/ws/browser", "/ws/agent"].includes(url.pathname)) { socket.destroy(); return; }
    if (url.pathname === "/ws/browser" && request.headers.origin !== config.publicOrigin) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  const broadcast = (payload: unknown) => { for (const client of browserClients) json(client.socket, payload); };

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", config.publicOrigin);
    if (url.pathname === "/ws/browser") {
      const ticketValue = url.searchParams.get("ticket") ?? "";
      const ticket = tickets.get(ticketValue);
      tickets.delete(ticketValue);
      if (!ticket || ticket.expiresAt < Date.now()) { socket.close(4401, "unauthorized"); return; }
      const client: BrowserClient = { socket, session: ticket.session };
      browserClients.add(client);
      json(socket, { type: "server.ready" });
      for (const snapshot of snapshots.values()) json(socket, { type: "device.snapshot", snapshot });
      socket.on("message", (raw) => {
        try {
          if (!auth.sessionFromToken(request.headers.cookie?.match(/(?:^|;\s*)yk_session=([^;]+)/)?.[1])) {
            json(socket, { type: "server.error", code: ErrorCode.Unauthorized, message: "会话已过期" });
            socket.close(4401, "session expired");
            return;
          }
          const parsed = BrowserMessageSchema.parse(JSON.parse(raw.toString()));
          if (parsed.type === "browser.refresh") {
            const snapshot = snapshots.get(parsed.deviceID);
            if (snapshot) json(socket, { type: "device.snapshot", snapshot });
            return;
          }
          const command = validateFreshCommand(parsed.command);
          const agent = agentClients.get(parsed.deviceID);
          if (!agent?.authenticated || agent.socket.readyState !== WebSocket.OPEN) { json(socket, { type: "command.result", commandID: command.id, ok: false, code: ErrorCode.DeviceOffline, message: "Mac 当前离线" }); return; }
          const existing = db.prepare("SELECT 1 FROM executed_commands WHERE command_id=?").get(command.id);
          if (existing) { json(socket, { type: "command.result", commandID: command.id, ok: false, code: ErrorCode.ReplayDetected, message: "命令已处理" }); return; }
          if (command.type.startsWith("app.")) {
            const bundleID = (command.payload as { bundleID: string }).bundleID;
            if (!(snapshots.get(parsed.deviceID)?.apps.some((candidate) => candidate.bundleID === bundleID))) { json(socket, { type: "command.result", commandID: command.id, ok: false, code: ErrorCode.InvalidCommand, message: "应用未由代理登记" }); return; }
          }
          if (requiresElevation(command)) {
            if (!command.elevationToken || !auth.consumeElevation(client.session.id, command.elevationToken, actionDigest(parsed.deviceID, command))) { json(socket, { type: "command.result", commandID: command.id, ok: false, code: ErrorCode.ElevationRequired, message: "需要再次验证 Passkey" }); return; }
          }
          db.prepare("INSERT INTO executed_commands(command_id,expires_at) VALUES(?,?)").run(command.id, Date.parse(command.expiresAt) + 60_000);
          const target = command.type.startsWith("app.") ? (command.payload as { bundleID: string }).bundleID : null;
          const auditID = crypto.randomUUID();
          db.prepare("INSERT INTO audit_events(id,admin_id,device_id,command_id,action,target,result,client_label,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(auditID, client.session.admin_id, parsed.deviceID, command.id, command.type, target, "pending", "web", Date.now());
          pendingCommands.set(command.id, { auditID, deviceID: parsed.deviceID, expiresAt: Date.parse(command.expiresAt) + 10_000 });
          json(agent.socket, { type: "server.command", command });
          json(socket, { type: "command.accepted", commandID: command.id });
        } catch (error) {
          json(socket, { type: "server.error", code: ErrorCode.InvalidCommand, message: error instanceof Error ? error.message : "无效消息" });
        }
      });
      socket.on("close", () => browserClients.delete(client));
      return;
    }

    const deviceID = url.searchParams.get("deviceID") ?? "";
    const row = db.prepare("SELECT public_key FROM devices WHERE id=?").get(deviceID) as { public_key: string } | undefined;
    if (!row) { socket.close(4401, "unknown device"); return; }
    const client: AgentClient = { socket, deviceID, authenticated: false, challenge: randomToken(32) };
    json(socket, { type: "server.challenge", challenge: client.challenge, protocolVersion: 1 });
    socket.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        if (!client.authenticated) {
          const message = AgentMessageSchema.parse(payload);
          if (message.type !== "agent.authenticate" || message.deviceID !== deviceID || Math.abs(Date.now() - Date.parse(message.timestamp)) > 30_000) throw new Error("INVALID_AGENT_AUTH");
          if (!verifyEd25519Signature(row.public_key, `${client.challenge}|${message.timestamp}|1`, message.signature)) throw new Error("INVALID_AGENT_SIGNATURE");
          client.authenticated = true;
          const old = agentClients.get(deviceID);
          if (old && old.socket !== socket) old.socket.close(4409, "replaced");
          agentClients.set(deviceID, client);
          db.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").run(Date.now(), deviceID);
          json(socket, { type: "server.authenticated" });
          broadcast({ type: "device.online", deviceID });
          return;
        }
        const message = AgentMessageSchema.parse(payload);
        db.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").run(Date.now(), deviceID);
        if (message.type === "agent.snapshot") {
          if (message.snapshot.deviceID !== deviceID) throw new Error("DEVICE_ID_MISMATCH");
          const snapshot = DeviceSnapshotSchema.parse({ ...message.snapshot, online: true, lastSeenAt: new Date().toISOString() });
          snapshots.set(deviceID, snapshot);
          broadcast({ type: "device.snapshot", snapshot });
        } else if (message.type === "agent.result") {
          const pending = pendingCommands.get(message.commandID);
          if (pending?.deviceID === deviceID) {
            db.prepare("UPDATE audit_events SET result=?,error_code=? WHERE id=?").run(message.ok ? "success" : "failed", message.ok ? null : message.code, pending.auditID);
            pendingCommands.delete(message.commandID);
            broadcast({ type: "command.result", commandID: message.commandID, ok: message.ok, code: message.code, message: message.message });
          }
        }
      } catch (error) {
        app.log.warn({ error }, "agent message rejected");
        json(socket, { type: "server.error", code: ErrorCode.Unauthorized, message: error instanceof Error ? error.message : "认证失败" });
        if (!client.authenticated) socket.close(4401, "authentication failed");
      }
    });
    socket.on("close", () => {
      if (agentClients.get(deviceID)?.socket === socket) {
        agentClients.delete(deviceID);
        for (const [commandID, pending] of pendingCommands) if (pending.deviceID === deviceID) failPending(commandID, ErrorCode.DeviceOffline, "Mac 当前离线");
        const previous = snapshots.get(deviceID);
        if (previous) snapshots.set(deviceID, { ...previous, online: false, lastSeenAt: new Date().toISOString() });
        broadcast({ type: "device.offline", deviceID });
      }
    });
  });

  if (fs.existsSync(config.webDistPath)) {
    await app.register(fastifyStatic, { root: config.webDistPath, wildcard: false });
    app.get("/*", async (_request, reply) => reply.type("text/html").sendFile("index.html"));
  }

  const housekeeping = setInterval(() => {
    cleanupExpired(db, config.auditRetentionDays);
    const now = Date.now();
    for (const [ticket, value] of tickets) if (value.expiresAt < now) tickets.delete(ticket);
    for (const [commandID, pending] of pendingCommands) if (pending.expiresAt < now) failPending(commandID, ErrorCode.CommandExpired, "代理未及时返回结果");
    for (const [deviceID, client] of agentClients) {
      const row = db.prepare("SELECT last_seen_at FROM devices WHERE id=?").get(deviceID) as { last_seen_at: number | null } | undefined;
      if (row?.last_seen_at && now - row.last_seen_at > config.agentOfflineAfterMs) client.socket.terminate();
    }
  }, 10_000);
  housekeeping.unref();

  return {
    app, db, config,
    close: async () => { clearInterval(housekeeping); for (const client of agentClients.values()) client.socket.close(); for (const client of browserClients) client.socket.close(); wss.close(); await app.close(); db.close(); }
  };
}
