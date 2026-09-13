import { describe, expect, it } from "vitest";
import { requiresElevation, validateFreshCommand } from "../src/index.js";

const base = { id: "7a5df370-8b0c-4a23-9182-264a87dbd622", protocolVersion: 1 as const };

describe("command protocol", () => {
  it("accepts a fresh bounded command", () => {
    const now = Date.now();
    const command = validateFreshCommand({
      ...base,
      type: "system.volume",
      payload: { value: 0.5 },
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 9_000).toISOString()
    }, now);
    expect(command.type).toBe("system.volume");
  });

  it("rejects expired and overlong commands", () => {
    const now = Date.now();
    expect(() => validateFreshCommand({ ...base, type: "system.sleep", payload: {}, issuedAt: new Date(now - 20_000).toISOString(), expiresAt: new Date(now - 1).toISOString() }, now)).toThrow("COMMAND_EXPIRED");
    expect(() => validateFreshCommand({ ...base, type: "system.sleep", payload: {}, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 20_000).toISOString() }, now)).toThrow("COMMAND_EXPIRED");
  });

  it("requires elevation only for declared high-impact operations", () => {
    const now = Date.now();
    const make = (type: string, payload: object) => validateFreshCommand({ ...base, id: crypto.randomUUID(), type, payload, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 9_000).toISOString() }, now);
    expect(requiresElevation(make("system.wifi", { enabled: false }))).toBe(true);
    expect(requiresElevation(make("system.wifi", { enabled: true }))).toBe(false);
    expect(requiresElevation(make("app.forceQuit", { bundleID: "com.apple.TextEdit" }))).toBe(true);
    expect(requiresElevation(make("system.volume", { value: 0.2 }))).toBe(false);
  });

  it("rejects paths and shell-like bundle identifiers", () => {
    const now = Date.now();
    expect(() => validateFreshCommand({ ...base, type: "app.launch", payload: { bundleID: "/Applications/Calculator.app;rm" }, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 9_000).toISOString() }, now)).toThrow();
  });
});
