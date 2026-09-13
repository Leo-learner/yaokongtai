import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import type { Command } from "@yaokongtai/protocol";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin", headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
  return body as T;
}

export const api = {
  config: () => request<{ hasAdmin: boolean; rpID: string; rpName: string }>("/api/config"),
  me: () => request<{ username: string; sessionExpiresAt: string }>("/api/me"),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  async bootstrap(token: string, username = "Leo") {
    const flow = await request<{ options: PublicKeyCredentialCreationOptionsJSON; flowID: string }>("/api/auth/bootstrap/options", { method: "POST", body: JSON.stringify({ token, username }) });
    const response: RegistrationResponseJSON = await startRegistration({ optionsJSON: flow.options });
    return request<{ recoveryCodes: string[] }>("/api/auth/bootstrap/verify", { method: "POST", body: JSON.stringify({ flowID: flow.flowID, response }) });
  },
  async login() {
    const flow = await request<{ options: PublicKeyCredentialRequestOptionsJSON; flowID: string }>("/api/auth/login/options", { method: "POST" });
    const response: AuthenticationResponseJSON = await startAuthentication({ optionsJSON: flow.options });
    return request<{ ok: true }>("/api/auth/login/verify", { method: "POST", body: JSON.stringify({ flowID: flow.flowID, response }) });
  },
  recover: (code: string) => request<{ ok: true }>("/api/auth/recover", { method: "POST", body: JSON.stringify({ code }) }),
  async addPasskey() {
    const flow = await request<{ options: PublicKeyCredentialCreationOptionsJSON; flowID: string }>("/api/auth/passkey/options", { method: "POST" });
    const response = await startRegistration({ optionsJSON: flow.options });
    return request<{ ok: true }>("/api/auth/passkey/verify", { method: "POST", body: JSON.stringify({ flowID: flow.flowID, response }) });
  },
  devices: () => request<import("@yaokongtai/protocol").DeviceSnapshot[]>("/api/devices"),
  pairing: () => request<{ code: string; expiresAt: string }>("/api/pairings", { method: "POST" }),
  audit: () => request<Array<{ id: string; action: string; target?: string; result: string; error_code?: string; createdAt: string }>>("/api/audit"),
  favorites: (deviceID: string) => request<Array<{ bundleID: string }>>(`/api/devices/${deviceID}/favorites`),
  setFavorites: (deviceID: string, bundleIDs: string[]) => request<{ ok: true }>(`/api/devices/${deviceID}/favorites`, { method: "PUT", body: JSON.stringify({ bundleIDs }) }),
  wsTicket: () => request<{ ticket: string }>("/api/ws-ticket", { method: "POST" }),
  async elevate(deviceID: string, command: Command) {
    const flow = await request<{ options: PublicKeyCredentialRequestOptionsJSON; flowID: string }>("/api/auth/elevation/options", { method: "POST", body: JSON.stringify({ deviceID, command }) });
    const response = await startAuthentication({ optionsJSON: flow.options });
    return request<{ elevationToken: string }>("/api/auth/elevation/verify", { method: "POST", body: JSON.stringify({ flowID: flow.flowID, response }) });
  }
};
