import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildServer, type RelayRuntime } from "../src/server.js";
import { AuthService } from "../src/auth.js";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { on } from "node:events";

const receive = async (messages: AsyncIterator<unknown[]>) => JSON.parse(((await messages.next()).value[0] as Buffer).toString()) as Record<string, unknown>;

let runtime: RelayRuntime | undefined;
afterEach(async () => runtime?.close());

describe("relay http surface", () => {
  it("reports health without leaking configuration", async () => {
    runtime = await buildServer({ nodeEnv: "test", databasePath: ":memory:", sessionSecret: "01234567890123456789012345678901", bootstrapToken: "bootstrap", webDistPath: "/nonexistent" });
    const response = await runtime.app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, protocolVersion: 1 });
    expect(response.body).not.toContain("secret");
  });

  it("rejects cross-origin writes", async () => {
    runtime = await buildServer({ nodeEnv: "test", databasePath: ":memory:", sessionSecret: "01234567890123456789012345678901", bootstrapToken: "bootstrap", publicOrigin: "http://localhost:3300", webDistPath: "/nonexistent" });
    const response = await runtime.app.inject({ method: "POST", url: "/api/auth/login/options", headers: { origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
  });

  it("does not expose protected APIs without a session", async () => {
    runtime = await buildServer({ nodeEnv: "test", databasePath: ":memory:", sessionSecret: "01234567890123456789012345678901", bootstrapToken: "bootstrap", webDistPath: "/nonexistent" });
    const response = await runtime.app.inject({ method: "GET", url: "/api/devices" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an offline command without queueing or auditing it", async () => {
    runtime = await buildServer({ nodeEnv: "test", databasePath: ":memory:", sessionSecret: "01234567890123456789012345678901", bootstrapToken: "bootstrap", webDistPath: "/nonexistent" });
    await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    const adminID = crypto.randomUUID();
    runtime.db.prepare("INSERT INTO admins(id,username,created_at) VALUES(?,?,?)").run(adminID, "Leo", Date.now());
    const token = new AuthService(runtime.db, runtime.config).createSession(adminID);
    const ticketResponse = await runtime.app.inject({ method: "POST", url: "/api/ws-ticket", headers: { cookie: `yk_session=${token}` } });
    const ticket = ticketResponse.json().ticket;
    const port = (runtime.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser?ticket=${ticket}`, { headers: { origin: runtime.config.publicOrigin, cookie: `yk_session=${token}` } });
    await new Promise<void>((resolve) => ws.once("message", () => resolve()));
    const now = Date.now();
    const command = { id: crypto.randomUUID(), protocolVersion: 1, type: "system.volume", payload: { value: 0.5 }, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 9000).toISOString() };
    ws.send(JSON.stringify({ type: "browser.command", deviceID: crypto.randomUUID(), command }));
    const result = await new Promise<{ code: string }>((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    expect(result.code).toBe("DEVICE_OFFLINE");
    expect(runtime.db.prepare("SELECT count(*) AS n FROM audit_events").get()).toEqual({ n: 0 });
    expect(runtime.db.prepare("SELECT count(*) AS n FROM executed_commands").get()).toEqual({ n: 0 });
    ws.terminate();
  });

  it("rejects an agent that cannot sign its challenge", async () => {
    runtime = await buildServer({ nodeEnv: "test", databasePath: ":memory:", sessionSecret: "01234567890123456789012345678901", bootstrapToken: "bootstrap", webDistPath: "/nonexistent" });
    await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    const deviceID = crypto.randomUUID();
    runtime.db.prepare("INSERT INTO devices(id,name,public_key,created_at) VALUES(?,?,?,?)").run(deviceID, "Test Mac", crypto.randomBytes(32).toString("base64"), Date.now());
    const port = (runtime.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent?deviceID=${deviceID}`);
    const challenge = await new Promise<{ type: string }>((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    expect(challenge.type).toBe("server.challenge");
    ws.send(JSON.stringify({ type: "agent.authenticate", deviceID, timestamp: new Date().toISOString(), signature: crypto.randomBytes(64).toString("base64") }));
    const result = await new Promise<{ code: string }>((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    expect(result.code).toBe("UNAUTHORIZED");
    ws.terminate();
  });

  it("authenticates an agent, returns command results, and blocks replay", async () => {
    runtime = await buildServer({ nodeEnv: "test", databasePath: ":memory:", sessionSecret: "01234567890123456789012345678901", bootstrapToken: "bootstrap", webDistPath: "/nonexistent" });
    await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (runtime.app.server.address() as AddressInfo).port;
    const adminID = crypto.randomUUID(), deviceID = crypto.randomUUID();
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = (keys.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");
    runtime.db.prepare("INSERT INTO admins(id,username,created_at) VALUES(?,?,?)").run(adminID, "Leo", Date.now());
    runtime.db.prepare("INSERT INTO devices(id,name,public_key,created_at) VALUES(?,?,?,?)").run(deviceID, "Test Mac", publicKey, Date.now());
    const token = new AuthService(runtime.db, runtime.config).createSession(adminID);
    const ticketResponse = await runtime.app.inject({ method: "POST", url: "/api/ws-ticket", headers: { cookie: `yk_session=${token}` } });
    const browser = new WebSocket(`ws://127.0.0.1:${port}/ws/browser?ticket=${ticketResponse.json().ticket}`, { headers: { origin: runtime.config.publicOrigin, cookie: `yk_session=${token}` } });
    const browserMessages = on(browser, "message");
    expect((await receive(browserMessages)).type).toBe("server.ready");
    const agent = new WebSocket(`ws://127.0.0.1:${port}/ws/agent?deviceID=${deviceID}`);
    const agentMessages = on(agent, "message");
    const challenge = await receive(agentMessages);
    const timestamp = new Date().toISOString();
    const signature = crypto.sign(null, Buffer.from(`${challenge.challenge}|${timestamp}|1`), keys.privateKey).toString("base64");
    agent.send(JSON.stringify({ type: "agent.authenticate", deviceID, timestamp, signature }));
    expect((await receive(agentMessages)).type).toBe("server.authenticated");
    expect((await receive(browserMessages)).type).toBe("device.online");
    agent.send(JSON.stringify({ type: "agent.snapshot", snapshot: { deviceID, deviceName: "Test Mac", online: true, lastSeenAt: new Date().toISOString(), apps: [], controls: { wifi: null, bluetooth: null, focus: null, darkMode: null, brightness: null, volume: 0.5, muted: false }, permissions: { accessibility: "unknown", automation: "unknown", bluetooth: "unknown", brightness: "unavailable" }, agentVersion: "0.1.0", protocolVersion: 1 } }));
    expect((await receive(browserMessages)).type).toBe("device.snapshot");
    const now = Date.now();
    const command = { id: crypto.randomUUID(), protocolVersion: 1, type: "system.volume", payload: { value: 0.6 }, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 9000).toISOString() };
    const request = JSON.stringify({ type: "browser.command", deviceID, command });
    browser.send(request);
    expect((await receive(browserMessages)).type).toBe("command.accepted");
    expect((await receive(agentMessages)).type).toBe("server.command");
    agent.send(JSON.stringify({ type: "agent.result", commandID: command.id, ok: true, code: "OK", message: "done" }));
    expect((await receive(browserMessages)).ok).toBe(true);
    browser.send(request);
    expect((await receive(browserMessages)).code).toBe("REPLAY_DETECTED");
    expect(runtime.db.prepare("SELECT result FROM audit_events WHERE command_id=?").get(command.id)).toEqual({ result: "success" });
    browser.terminate(); agent.terminate();
  });
});
