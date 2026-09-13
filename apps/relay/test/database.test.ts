import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, cleanupExpired, type DB } from "../src/database.js";
import { AuthService } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { actionDigest } from "../src/server.js";
import { hashRecoveryCode, sha256 } from "../src/crypto.js";
import type { Command } from "@yaokongtai/protocol";

let db: DB | undefined;
afterEach(() => db?.close());

describe("relay security state", () => {
  it("consumes an elevation token once and binds it to one command", () => {
    db = createDatabase(":memory:");
    const config = loadConfig({ nodeEnv: "test", databasePath: ":memory:", sessionSecret: "01234567890123456789012345678901", bootstrapToken: "bootstrap" });
    const auth = new AuthService(db, config);
    const adminID = crypto.randomUUID();
    db.prepare("INSERT INTO admins(id,username,created_at) VALUES(?,?,?)").run(adminID, "Leo", Date.now());
    const token = auth.createSession(adminID);
    const session = auth.sessionFromToken(token)!;
    const command: Command = { id: crypto.randomUUID(), protocolVersion: 1, type: "system.sleep", payload: {}, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 9000).toISOString(), elevationToken: "placeholder-placeholder-placeholder-123" };
    const digest = actionDigest(crypto.randomUUID(), command);
    const elevation = "elevation-elevation-elevation-123";
    db.prepare("INSERT INTO elevations(id,session_id,token_hash,action_digest,expires_at) VALUES(?,?,?,?,?)").run(crypto.randomUUID(), session.id, sha256(elevation), digest, Date.now() + 60_000);
    expect(auth.consumeElevation(session.id, elevation, actionDigest(crypto.randomUUID(), command))).toBe(false);
    expect(auth.consumeElevation(session.id, elevation, digest)).toBe(true);
    expect(auth.consumeElevation(session.id, elevation, digest)).toBe(false);
  });

  it("uses each recovery code once and limits its session to ten minutes", () => {
    db = createDatabase(":memory:");
    const config = loadConfig({ nodeEnv: "test", databasePath: ":memory:", sessionSecret: "01234567890123456789012345678901", bootstrapToken: "bootstrap" });
    const auth = new AuthService(db, config);
    const adminID = crypto.randomUUID();
    const code = "ABCDE-FGHIJ";
    db.prepare("INSERT INTO admins(id,username,created_at) VALUES(?,?,?)").run(adminID, "Leo", Date.now());
    db.prepare("INSERT INTO recovery_codes(id,admin_id,code_hash,created_at) VALUES(?,?,?,?)").run(crypto.randomUUID(), adminID, hashRecoveryCode(code), Date.now());
    const { sessionToken } = auth.recover(code);
    const session = auth.sessionFromToken(sessionToken);
    expect(session?.expires_at).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(session?.expires_at).toBeLessThan(Date.now() + 11 * 60_000);
    expect(() => auth.recover(code)).toThrow("INVALID_RECOVERY_CODE");
  });

  it("deletes expired state and old audits", () => {
    db = createDatabase(":memory:");
    db.prepare("INSERT INTO challenges(id,kind,challenge,expires_at) VALUES('old','login','x',0)").run();
    db.prepare("INSERT INTO audit_events(id,action,result,client_label,created_at) VALUES('old-audit','test','success','test',0)").run();
    cleanupExpired(db, 30, Date.now());
    expect(db.prepare("SELECT count(*) AS n FROM challenges").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM audit_events").get()).toEqual({ n: 0 });
  });
});
