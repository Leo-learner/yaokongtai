import type { FastifyReply, FastifyRequest } from "fastify";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import crypto from "node:crypto";
import type { DB } from "./database.js";
import type { RelayConfig } from "./config.js";
import { hashRecoveryCode, randomToken, sha256, timingSafeEqualHash, verifyRecoveryCode } from "./crypto.js";

type SessionRow = { id: string; admin_id: string; expires_at: number };
type PasskeyRow = { id: string; admin_id: string; public_key: Buffer; counter: number; transports: string };
type ChallengeRow = { id: string; kind: string; challenge: string; admin_id: string | null; action_digest: string | null; expires_at: number };

export class AuthService {
  constructor(private db: DB, private config: RelayConfig) {}

  hasAdmin() { return Boolean(this.db.prepare("SELECT 1 FROM admins LIMIT 1").get()); }

  private saveChallenge(kind: string, challenge: string, adminID: string | null, actionDigest: string | null) {
    const id = randomToken(24);
    this.db.prepare("INSERT INTO challenges(id, kind, challenge, admin_id, action_digest, expires_at) VALUES(?,?,?,?,?,?)")
      .run(id, kind, challenge, adminID, actionDigest, Date.now() + 5 * 60_000);
    return id;
  }

  private takeChallenge(id: string, kind: string): ChallengeRow {
    const row = this.db.prepare("SELECT * FROM challenges WHERE id=? AND kind=?").get(id, kind) as ChallengeRow | undefined;
    this.db.prepare("DELETE FROM challenges WHERE id=?").run(id);
    if (!row || row.expires_at < Date.now()) throw new Error("CHALLENGE_EXPIRED");
    return row;
  }

  async bootstrapOptions(token: string, username: string) {
    if (this.hasAdmin()) throw new Error("BOOTSTRAP_CLOSED");
    if (!timingSafeEqualHash(token, this.config.bootstrapToken)) throw new Error("INVALID_BOOTSTRAP_TOKEN");
    const adminID = crypto.randomUUID();
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpID,
      userID: Buffer.from(adminID),
      userName: username,
      userDisplayName: username,
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" }
    });
    return { options, flowID: this.saveChallenge("bootstrap", options.challenge, adminID, username) };
  }

  async bootstrapVerify(flowID: string, response: RegistrationResponseJSON) {
    if (this.hasAdmin()) throw new Error("BOOTSTRAP_CLOSED");
    const flow = this.takeChallenge(flowID, "bootstrap");
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.config.publicOrigin,
      expectedRPID: this.config.rpID,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo || !flow.admin_id) throw new Error("PASSKEY_VERIFICATION_FAILED");
    const { credential } = verification.registrationInfo;
    const now = Date.now();
    const username = flow.action_digest ?? "Leo";
    const codes = Array.from({ length: 8 }, () => `${randomToken(5).slice(0, 5).toUpperCase()}-${randomToken(5).slice(0, 5).toUpperCase()}`);
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO admins(id, username, created_at) VALUES(?,?,?)").run(flow.admin_id, username, now);
      this.db.prepare("INSERT INTO passkeys(id, admin_id, public_key, counter, transports, created_at) VALUES(?,?,?,?,?,?)")
        .run(credential.id, flow.admin_id, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), now);
      const insertCode = this.db.prepare("INSERT INTO recovery_codes(id, admin_id, code_hash, created_at) VALUES(?,?,?,?)");
      for (const code of codes) insertCode.run(crypto.randomUUID(), flow.admin_id, hashRecoveryCode(code), now);
    })();
    return { sessionToken: this.createSession(flow.admin_id), recoveryCodes: codes };
  }

  async loginOptions() {
    const credentials = this.db.prepare("SELECT id, transports FROM passkeys ORDER BY created_at").all() as Pick<PasskeyRow, "id" | "transports">[];
    if (!credentials.length) throw new Error("NO_PASSKEY");
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpID,
      userVerification: "required",
      allowCredentials: credentials.map((key) => ({ id: key.id, transports: JSON.parse(key.transports) }))
    });
    return { options, flowID: this.saveChallenge("login", options.challenge, null, null) };
  }

  async addPasskeyOptions(session: SessionRow) {
    const admin = this.db.prepare("SELECT username FROM admins WHERE id=?").get(session.admin_id) as { username: string } | undefined;
    if (!admin) throw new Error("UNKNOWN_ADMIN");
    const credentials = this.db.prepare("SELECT id, transports FROM passkeys WHERE admin_id=?").all(session.admin_id) as Pick<PasskeyRow, "id" | "transports">[];
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpID,
      userID: Buffer.from(session.admin_id),
      userName: admin.username,
      userDisplayName: admin.username,
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      excludeCredentials: credentials.map((key) => ({ id: key.id, transports: JSON.parse(key.transports) }))
    });
    return { options, flowID: this.saveChallenge("add-passkey", options.challenge, session.admin_id, null) };
  }

  async addPasskeyVerify(session: SessionRow, flowID: string, response: RegistrationResponseJSON) {
    const flow = this.takeChallenge(flowID, "add-passkey");
    if (flow.admin_id !== session.admin_id) throw new Error("PASSKEY_SESSION_MISMATCH");
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.config.publicOrigin,
      expectedRPID: this.config.rpID,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) throw new Error("PASSKEY_VERIFICATION_FAILED");
    const { credential } = verification.registrationInfo;
    this.db.prepare("INSERT INTO passkeys(id, admin_id, public_key, counter, transports, created_at) VALUES(?,?,?,?,?,?)")
      .run(credential.id, session.admin_id, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), Date.now());
  }

  async loginVerify(flowID: string, response: AuthenticationResponseJSON) {
    const flow = this.takeChallenge(flowID, "login");
    const passkey = this.db.prepare("SELECT * FROM passkeys WHERE id=?").get(response.id) as PasskeyRow | undefined;
    if (!passkey) throw new Error("UNKNOWN_PASSKEY");
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.config.publicOrigin,
      expectedRPID: this.config.rpID,
      credential: { id: passkey.id, publicKey: new Uint8Array(passkey.public_key), counter: passkey.counter, transports: JSON.parse(passkey.transports) },
      requireUserVerification: true
    });
    if (!verification.verified) throw new Error("PASSKEY_VERIFICATION_FAILED");
    this.db.prepare("UPDATE passkeys SET counter=? WHERE id=?").run(verification.authenticationInfo.newCounter, passkey.id);
    return { sessionToken: this.createSession(passkey.admin_id) };
  }

  async elevationOptions(session: SessionRow, actionDigest: string) {
    const credentials = this.db.prepare("SELECT id, transports FROM passkeys WHERE admin_id=?").all(session.admin_id) as Pick<PasskeyRow, "id" | "transports">[];
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpID,
      userVerification: "required",
      allowCredentials: credentials.map((key) => ({ id: key.id, transports: JSON.parse(key.transports) }))
    });
    return { options, flowID: this.saveChallenge("elevation", options.challenge, session.admin_id, actionDigest) };
  }

  async elevationVerify(session: SessionRow, flowID: string, response: AuthenticationResponseJSON) {
    const flow = this.takeChallenge(flowID, "elevation");
    if (flow.admin_id !== session.admin_id || !flow.action_digest) throw new Error("ELEVATION_MISMATCH");
    const passkey = this.db.prepare("SELECT * FROM passkeys WHERE id=? AND admin_id=?").get(response.id, session.admin_id) as PasskeyRow | undefined;
    if (!passkey) throw new Error("UNKNOWN_PASSKEY");
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.config.publicOrigin,
      expectedRPID: this.config.rpID,
      credential: { id: passkey.id, publicKey: new Uint8Array(passkey.public_key), counter: passkey.counter, transports: JSON.parse(passkey.transports) },
      requireUserVerification: true
    });
    if (!verification.verified) throw new Error("PASSKEY_VERIFICATION_FAILED");
    this.db.prepare("UPDATE passkeys SET counter=? WHERE id=?").run(verification.authenticationInfo.newCounter, passkey.id);
    const token = randomToken();
    this.db.prepare("INSERT INTO elevations(id,session_id,token_hash,action_digest,expires_at) VALUES(?,?,?,?,?)")
      .run(crypto.randomUUID(), session.id, sha256(token), flow.action_digest, Date.now() + 60_000);
    return token;
  }

  consumeElevation(sessionID: string, token: string, actionDigest: string): boolean {
    const row = this.db.prepare("SELECT id, action_digest, expires_at, used_at FROM elevations WHERE session_id=? AND token_hash=?")
      .get(sessionID, sha256(token)) as { id: string; action_digest: string; expires_at: number; used_at: number | null } | undefined;
    if (!row || row.used_at || row.expires_at < Date.now() || row.action_digest !== actionDigest) return false;
    this.db.prepare("UPDATE elevations SET used_at=? WHERE id=?").run(Date.now(), row.id);
    return true;
  }

  recover(code: string) {
    const rows = this.db.prepare("SELECT id, admin_id, code_hash FROM recovery_codes WHERE used_at IS NULL").all() as { id: string; admin_id: string; code_hash: string }[];
    const match = rows.find((row) => verifyRecoveryCode(code, row.code_hash));
    if (!match) throw new Error("INVALID_RECOVERY_CODE");
    this.db.prepare("UPDATE recovery_codes SET used_at=? WHERE id=?").run(Date.now(), match.id);
    return { sessionToken: this.createSession(match.admin_id, 10 * 60_000) };
  }

  createSession(adminID: string, duration = this.config.sessionDays * 86_400_000) {
    const token = randomToken();
    this.db.prepare("INSERT INTO sessions(id,admin_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)")
      .run(crypto.randomUUID(), adminID, sha256(token), Date.now() + duration, Date.now());
    return token;
  }

  sessionFromToken(token: string | undefined): SessionRow | null {
    if (!token) return null;
    const row = this.db.prepare("SELECT id, admin_id, expires_at FROM sessions WHERE token_hash=?").get(sha256(token)) as SessionRow | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    return row;
  }

  sessionFromRequest(request: FastifyRequest) { return this.sessionFromToken(request.cookies.yk_session); }

  setSessionCookie(reply: FastifyReply, token: string) {
    reply.setCookie("yk_session", token, { path: "/", httpOnly: true, secure: this.config.nodeEnv === "production", sameSite: "strict", maxAge: this.config.sessionDays * 86_400 });
  }

  logout(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies.yk_session;
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha256(token));
    reply.clearCookie("yk_session", { path: "/" });
  }
}
