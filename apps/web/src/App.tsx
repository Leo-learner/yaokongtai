import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Command, DeviceSnapshot, InstalledApplication } from "@yaokongtai/protocol";
import { AppWindow, Bluetooth, ChevronRight, CircleHelp, Clock3, Cog, Download, Laptop, LockKeyhole, Moon, Music2, Pause, Play, Power, RotateCw, Search, Settings2, ShieldCheck, SkipBack, SkipForward, SlidersHorizontal, Star, Sun, Volume2, Wifi } from "lucide-react";
import { api } from "./api";

type Tab = "apps" | "system" | "settings";
type Sheet = "media" | "power" | "wifi" | "forceQuit" | "pairing" | "audit" | "security" | "permissions" | "updates" | null;
type Toast = { tone: "ok" | "error"; text: string } | null;

function makeCommand(type: Command["type"], payload: Record<string, unknown>): Command {
  const now = Date.now();
  return { id: crypto.randomUUID(), protocolVersion: 1, type, payload, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 9_000).toISOString() } as Command;
}

function AuthScreen({ hasAdmin, onReady }: { hasAdmin: boolean; onReady: () => void }) {
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); } };
  if (codes.length) return <main className="auth-shell"><section className="auth-card"><ShieldCheck size={36}/><h1>保存恢复码</h1><p>每个恢复码只能使用一次。请离线保存，关闭后不会再次显示。</p><pre className="recovery-codes">{codes.join("\n")}</pre><button className="primary" onClick={onReady}>我已安全保存</button></section></main>;
  return <main className="auth-shell"><section className="auth-card"><div className="brand-mark"><Laptop/></div><h1>遥控台</h1><p>{hasAdmin ? "使用 Passkey 验证身份后继续。" : "首次使用需要管理员引导令牌，并创建一个 Passkey。"}</p>
    {!hasAdmin && <label>引导令牌<input value={bootstrapToken} onChange={(e) => setBootstrapToken(e.target.value)} autoComplete="off" /></label>}
    <button className="primary" disabled={busy} onClick={() => run(async () => { if (hasAdmin) await api.login(); else { const result = await api.bootstrap(bootstrapToken); setCodes(result.recoveryCodes); return; } onReady(); })}>{busy ? "正在验证…" : hasAdmin ? "使用 Passkey 登录" : "创建 Passkey"}</button>
    {hasAdmin && <details><summary>使用恢复码</summary><label>恢复码<input value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} autoComplete="one-time-code" /></label><button className="secondary" disabled={busy || !recoveryCode} onClick={() => run(async () => { await api.recover(recoveryCode); onReady(); })}>恢复登录</button></details>}
    {error && <p className="error" role="alert">{error}</p>}
  </section></main>;
}

function DeviceHeader({ device }: { device?: DeviceSnapshot }) {
  return <header className="device-header"><h1>遥控台</h1><div className={`device-status ${device?.online ? "online" : "offline"}`}><span className="status-dot"/><span>{device?.deviceName ?? "尚未配对 Mac"}</span>{device && <><span>·</span><strong>{device.online ? "在线" : "离线"}</strong></>}</div></header>;
}

function AppIcon({ app }: { app: InstalledApplication }) {
  return app.icon ? <img className="app-icon" src={app.icon} alt="" /> : <span className="app-icon fallback" aria-hidden>{app.name.slice(0, 1)}</span>;
}

function AppsPage({ device, favorites, setFavorites, send, forceQuit }: { device?: DeviceSnapshot; favorites: string[]; setFavorites: (ids: string[]) => void; send: (command: Command) => void; forceQuit: (app: InstalledApplication) => void }) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const apps = device?.apps ?? [];
  const selected = favorites.length ? apps.filter((app) => favorites.includes(app.bundleID)).sort((a, b) => favorites.indexOf(a.bundleID) - favorites.indexOf(b.bundleID)) : apps.slice(0, 4);
  const visible = (showAll || query ? apps : selected).filter((app) => app.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, showAll || query ? 100 : 4);
  const toggleFavorite = (bundleID: string) => setFavorites(favorites.includes(bundleID) ? favorites.filter((id) => id !== bundleID) : [...favorites, bundleID].slice(0, 12));
  return <section className="page-content"><div className="search"><Search size={19}/><input aria-label="搜索应用" placeholder="搜索应用" value={query} onChange={(e) => setQuery(e.target.value)}/></div>
    {!device?.online && <OfflineBlock />}
    {device?.online && visible.length === 0 && <div className="empty-inline"><AppWindow/><p>{apps.length ? "没有匹配的应用" : "代理尚未返回应用列表"}</p></div>}
    <div className="app-list">{visible.map((app) => <article className="app-row" key={app.bundleID}><AppIcon app={app}/><div className="app-copy"><strong>{app.name}</strong><span>{app.running ? "正在运行" : "未运行"}</span></div>{(showAll || query) && <button className={`icon-button ${favorites.includes(app.bundleID) ? "starred" : ""}`} aria-label={favorites.includes(app.bundleID) ? "取消收藏" : "收藏"} onClick={() => toggleFavorite(app.bundleID)}><Star size={18} fill={favorites.includes(app.bundleID) ? "currentColor" : "none"}/></button>}{(showAll || query) && app.running && !app.protected && <button className="icon-button force-quit" aria-label={`强制退出 ${app.name}`} onClick={() => forceQuit(app)}><Power size={17}/></button>}<button className={app.running ? "secondary compact" : "primary compact"} disabled={!device?.online || (app.protected && app.running)} onClick={() => send(makeCommand(app.running ? "app.quit" : "app.launch", { bundleID: app.bundleID }))}>{app.protected && app.running ? "受保护" : app.running ? "退出" : "打开"}</button></article>)}</div>
    {device?.online && !query && <button className="disclosure plain" onClick={() => setShowAll(!showAll)}><span>{showAll ? "收起应用目录" : "查看所有应用"}</span><ChevronRight size={20} className={showAll ? "rotated" : ""}/></button>}
  </section>;
}

function OfflineBlock() { return <div className="offline-block"><Laptop size={44}/><h2>Mac 当前离线</h2><p>控制不会排队执行。Mac 唤醒并重新联网后会自动恢复。</p></div>; }

function SystemPage({ device, send, openSheet }: { device?: DeviceSnapshot; send: (command: Command) => void; openSheet: (sheet: Sheet) => void }) {
  const controls = device?.controls;
  const disabled = !device?.online;
  const toggles = [
    { label: "Wi‑Fi", icon: Wifi, value: controls?.wifi, type: "system.wifi" },
    { label: "蓝牙", icon: Bluetooth, value: controls?.bluetooth, type: "system.bluetooth" },
    { label: "勿扰模式", icon: Moon, value: controls?.focus, type: "system.focus" },
    { label: "深色模式", icon: Sun, value: controls?.darkMode, type: "system.darkMode" }
  ] as const;
  return <section className={`page-content system-page ${disabled ? "disabled-page" : ""}`}>
    {disabled && <OfflineBlock/>}
    <div className="toggle-grid">{toggles.map(({ label, icon: Icon, value, type }) => <button key={label} className={`toggle-tile ${value ? "active" : ""}`} disabled={disabled || value == null} aria-pressed={Boolean(value)} onClick={() => send(makeCommand(type, { enabled: !value }))}><Icon/><span>{label}</span></button>)}</div>
    <Level icon={<Sun/>} label="亮度" value={controls?.brightness} disabled={disabled || device?.permissions.brightness === "unavailable"} onChange={(value) => send(makeCommand("system.brightness", { value }))}/>
    <Level icon={<Volume2/>} label="音量" value={controls?.volume} disabled={disabled} onChange={(value) => send(makeCommand("system.volume", { value }))}/>
    <div className="disclosure-group"><button className="disclosure" disabled={disabled} onClick={() => openSheet("media")}><span><Play size={20}/>媒体控制</span><ChevronRight/></button><button className="disclosure" disabled={disabled} onClick={() => openSheet("power")}><span><LockKeyhole size={20}/>锁屏与睡眠</span><ChevronRight/></button></div>
  </section>;
}

function Level({ icon, label, value, disabled, onChange }: { icon: React.ReactNode; label: string; value: number | null | undefined; disabled: boolean; onChange: (value: number) => void }) {
  const timer = useRef<number | undefined>(undefined);
  return <label className="level-control">{icon}<span>{label}</span><input type="range" min="0" max="1" step="0.01" value={value ?? 0} disabled={disabled || value == null} onChange={(e) => { const next = Number(e.target.value); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => onChange(next), 150); }}/><output>{value == null ? "—" : `${Math.round(value * 100)}%`}</output></label>;
}

function SettingsPage({ device, openSheet, logout }: { device?: DeviceSnapshot; openSheet: (sheet: Sheet) => void; logout: () => void }) {
  const permissionOK = device && Object.values(device.permissions).every((value) => value === "authorized" || value === "available");
  const rows = [
    { sheet: "security" as const, icon: ShieldCheck, title: "安全与 Passkey", subtitle: "Passkey 登录 · 恢复码可用" },
    { sheet: "permissions" as const, icon: Settings2, title: "Mac 代理与权限", subtitle: device ? permissionOK ? "所需权限均已授权" : "部分功能需要授权" : "尚未配对 Mac" },
    { sheet: "updates" as const, icon: RotateCw, title: "自动更新", subtitle: device ? `已配置 · 版本 ${device.agentVersion}` : "安装代理后可用" },
    { sheet: "audit" as const, icon: Clock3, title: "操作记录", subtitle: "保留 30 天" }
  ];
  return <section className="page-content settings-list">{rows.map(({ sheet, icon: Icon, title, subtitle }) => <button className="settings-row" key={sheet} onClick={() => openSheet(sheet)}><Icon/><span><strong>{title}</strong><small>{subtitle}</small></span><ChevronRight/></button>)}<button className="logout" onClick={logout}>退出登录</button></section>;
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const items = [{ id: "apps" as const, label: "应用", icon: AppWindow }, { id: "system" as const, label: "系统", icon: SlidersHorizontal }, { id: "settings" as const, label: "设置", icon: Cog }];
  return <nav className="tab-bar" aria-label="主导航">{items.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? "selected" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}><Icon/><span>{label}</span></button>)}</nav>;
}

function SheetView({ sheet, close, device, forceQuitTarget, send, createPairing, audit, elevateAndSend, addPasskey }: { sheet: Sheet; close: () => void; device?: DeviceSnapshot; forceQuitTarget?: InstalledApplication; send: (command: Command) => void; createPairing: () => Promise<string>; audit: Array<{ id: string; action: string; target?: string; result: string; createdAt: string }>; elevateAndSend: (command: Command) => Promise<void>; addPasskey: () => Promise<void> }) {
  const [pairing, setPairing] = useState("");
  const action = (command: Command) => { close(); if (["system.lock", "system.sleep", "app.forceQuit"].includes(command.type) || (command.type === "system.wifi" && command.payload.enabled === false)) void elevateAndSend(command); else send(command); };
  return <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}><section className="sheet" role="dialog" aria-modal="true"><div className="sheet-handle"/>
    {sheet === "media" && <><h2>媒体控制</h2><p>控制当前接管系统媒体键的应用。</p><div className="media-controls"><button onClick={() => action(makeCommand("media.previous", {}))}><SkipBack/></button><button className="play" onClick={() => action(makeCommand("media.playPause", {}))}><Pause/></button><button onClick={() => action(makeCommand("media.next", {}))}><SkipForward/></button></div></>}
    {sheet === "power" && <><h2>锁屏与睡眠</h2><p>这些操作需要再次验证 Passkey。</p><button className="sheet-action" onClick={() => action(makeCommand("system.lock", {}))}><LockKeyhole/>锁定屏幕</button><button className="sheet-action warning" onClick={() => action(makeCommand("system.sleep", {}))}><Moon/>进入睡眠</button></>}
    {sheet === "wifi" && <><h2>关闭 Wi‑Fi？</h2><p>这会断开 Mac 与中继的连接。重新联网前无法继续遥控，并且需要再次验证 Passkey。</p><button className="sheet-action warning" onClick={() => action(makeCommand("system.wifi", { enabled: false }))}><Wifi/>验证并关闭 Wi‑Fi</button></>}
    {sheet === "forceQuit" && forceQuitTarget && <><h2>强制退出 {forceQuitTarget.name}？</h2><p>未保存的内容可能丢失。此操作需要再次验证 Passkey。</p><button className="sheet-action warning" onClick={() => action(makeCommand("app.forceQuit", { bundleID: forceQuitTarget.bundleID }))}><Power/>验证并强制退出</button></>}
    {sheet === "pairing" && <><h2>配对 Mac 代理</h2><p>在“遥控台代理”菜单中输入这个一次性配对码。有效期 10 分钟。</p>{pairing ? <div className="pairing-code">{pairing}</div> : <button className="primary" onClick={() => void createPairing().then(setPairing)}>生成配对码</button>}</>}
    {sheet === "security" && <><h2>安全与 Passkey</h2><p>登录会话保持 7 天。强制退出、关闭 Wi‑Fi、锁屏和睡眠会再次验证 Passkey。使用恢复码登录后，请在 10 分钟内添加新 Passkey。</p><div className="info-row"><ShieldCheck/><span>Passkey 已启用</span></div><div className="info-row"><Clock3/><span>提权令牌 60 秒后失效且只能使用一次</span></div><button className="primary" onClick={() => void addPasskey()}>添加 Passkey</button></>}
    {sheet === "permissions" && <><h2>Mac 代理与权限</h2>{device ? <div className="permission-list">{Object.entries(device.permissions).map(([key, value]) => <div className="info-row" key={key}><CircleHelp/><span>{({ accessibility: "辅助功能", automation: "自动化", bluetooth: "蓝牙", brightness: "亮度" } as Record<string,string>)[key]}</span><strong>{value === "authorized" || value === "available" ? "可用" : "需要检查"}</strong></div>)}</div> : <><p>尚未配对代理。</p><button className="primary" onClick={() => { close(); }}>返回后生成配对码</button></>}</>}
    {sheet === "updates" && <><h2>自动更新</h2><div className="info-row"><Download/><span>定期检查更新</span></div><p>安装前会提示，更新包和清单必须通过 EdDSA 签名校验。</p></>}
    {sheet === "audit" && <><h2>操作记录</h2><div className="audit-list">{audit.length ? audit.map((item) => <div className="audit-row" key={item.id}><span><strong>{item.action}</strong><small>{item.target ?? "系统"}</small></span><span><b className={item.result}>{item.result}</b><small>{new Date(item.createdAt).toLocaleString("zh-CN")}</small></span></div>) : <p>尚无操作记录</p>}</div></>}
    <button className="sheet-cancel" onClick={close}>完成</button>
  </section></div>;
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [hasAdmin, setHasAdmin] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [devices, setDevices] = useState<DeviceSnapshot[]>([]);
  const [tab, setTab] = useState<Tab>("apps");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [forceQuitTarget, setForceQuitTarget] = useState<InstalledApplication | undefined>();
  const [favorites, setFavoritesState] = useState<string[]>([]);
  const [audit, setAudit] = useState<Array<{ id: string; action: string; target?: string; result: string; createdAt: string }>>([]);
  const [toast, setToast] = useState<Toast>(null);
  const socket = useRef<WebSocket | null>(null);
  const device = devices[0];

  const refreshAuth = useCallback(async () => {
    const config = await api.config(); setHasAdmin(config.hasAdmin);
    try { await api.me(); setAuthenticated(true); } catch { setAuthenticated(false); }
    setBooting(false);
  }, []);
  useEffect(() => { void refreshAuth(); }, [refreshAuth]);

  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    let retry: number | undefined;
    const connect = async () => {
      try {
        const initial = await api.devices();
        if (disposed) return;
        setDevices(initial);
        const { ticket } = await api.wsTicket();
        if (disposed) return;
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/browser?ticket=${encodeURIComponent(ticket)}`);
        socket.current = ws;
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "device.snapshot") setDevices((current) => [message.snapshot, ...current.filter((item) => item.deviceID !== message.snapshot.deviceID)]);
          if (message.type === "device.offline") setDevices((current) => current.map((item) => item.deviceID === message.deviceID ? { ...item, online: false } : item));
          if (message.type === "command.result") setToast({ tone: message.ok ? "ok" : "error", text: message.ok ? "操作已完成" : message.message });
        };
        ws.onclose = () => { if (!disposed) retry = window.setTimeout(() => void connect(), 1500); };
      } catch { if (!disposed) retry = window.setTimeout(() => void connect(), 1500); }
    };
    void connect();
    return () => { disposed = true; window.clearTimeout(retry); socket.current?.close(); socket.current = null; };
  }, [authenticated]);
  useEffect(() => { if (!device) return; void api.favorites(device.deviceID).then((rows) => setFavoritesState(rows.map((row) => row.bundleID))).catch(() => undefined); }, [device?.deviceID]);
  useEffect(() => { const timer = window.setTimeout(() => setToast(null), 3500); return () => window.clearTimeout(timer); }, [toast]);

  const send = useCallback((command: Command) => {
    if (!device || socket.current?.readyState !== WebSocket.OPEN) { setToast({ tone: "error", text: "Mac 当前离线" }); return; }
    socket.current.send(JSON.stringify({ type: "browser.command", deviceID: device.deviceID, command }));
  }, [device]);
  const elevateAndSend = useCallback(async (command: Command) => {
    if (!device) return;
    try { const { elevationToken } = await api.elevate(device.deviceID, command); send({ ...command, elevationToken } as Command); }
    catch (error) { setToast({ tone: "error", text: error instanceof Error ? error.message : "Passkey 验证失败" }); }
  }, [device, send]);
  const setFavorites = (ids: string[]) => { setFavoritesState(ids); if (device) void api.setFavorites(device.deviceID, ids).catch((error) => setToast({ tone: "error", text: error.message })); };
  const openSheet = (next: Sheet) => { setSheet(next); if (next === "audit") void api.audit().then(setAudit); };

  if (booting) return <main className="loading"><div className="spinner"/><span>正在连接遥控台…</span></main>;
  if (!authenticated) return <AuthScreen hasAdmin={hasAdmin} onReady={() => { setAuthenticated(true); setBooting(false); }} />;
  return <div className="app-shell"><DeviceHeader device={device}/><main className="main-region">
    {tab === "apps" && <AppsPage device={device} favorites={favorites} setFavorites={setFavorites} send={send} forceQuit={(app) => { setForceQuitTarget(app); setSheet("forceQuit"); }}/>}
    {tab === "system" && <SystemPage device={device} send={(command) => { if (command.type === "system.wifi" && command.payload.enabled === false) setSheet("wifi"); else send(command); }} openSheet={openSheet}/>}
    {tab === "settings" && <SettingsPage device={device} openSheet={(next) => { if (next === "permissions" && !device) setSheet("pairing"); else openSheet(next); }} logout={() => void api.logout().then(() => { setAuthenticated(false); socket.current?.close(); })}/>}
  </main><TabBar tab={tab} setTab={setTab}/>
  {!device && tab !== "settings" && <button className="floating-pair" onClick={() => setSheet("pairing")}>配对 Mac</button>}
  {sheet && <SheetView sheet={sheet} close={() => setSheet(null)} device={device} forceQuitTarget={forceQuitTarget} send={send} elevateAndSend={elevateAndSend} createPairing={async () => (await api.pairing()).code} audit={audit} addPasskey={async () => { try { await api.addPasskey(); setToast({ tone: "ok", text: "Passkey 已添加" }); setSheet(null); } catch (error) { setToast({ tone: "error", text: error instanceof Error ? error.message : "添加失败" }); } }}/>}
  {toast && <div className={`toast ${toast.tone}`} role="status">{toast.text}</div>}
  </div>;
}
