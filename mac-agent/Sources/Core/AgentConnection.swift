import CryptoKit
import Foundation

@MainActor
final class AgentConnection: ObservableObject {
    enum Status: Equatable { case unpaired, connecting, connected, failed(String) }

    @Published private(set) var status: Status = .unpaired
    @Published private(set) var lastMessage = "等待配对"
    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    @Published private(set) var deviceID: UUID?

    private let controller = SystemController()
    private var socket: URLSessionWebSocketTask?
    private var heartbeat: Task<Void, Never>?
    private var reconnect: Task<Void, Never>?

    init() {
        serverURL = ProcessInfo.processInfo.environment["YAOKONGTAI_SERVER_URL"]
            ?? UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:3300"
        if let raw = UserDefaults.standard.string(forKey: "deviceID"), let id = UUID(uuidString: raw) { deviceID = id; status = .connecting }
        if let code = ProcessInfo.processInfo.environment["YAOKONGTAI_PAIRING_CODE"], deviceID == nil {
            Task { try? await pair(code: code) }
        } else if deviceID != nil { Task { await connect() } }
    }

    deinit { heartbeat?.cancel(); reconnect?.cancel(); socket?.cancel(with: .goingAway, reason: nil) }

    func pair(code: String) async throws {
        guard let base = URL(string: serverURL) else { throw AgentError.executionFailed("服务器地址无效") }
        let key = try KeychainStore.signingKey()
        var request = URLRequest(url: base.appending(path: "/api/agent/enroll"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
            "deviceName": Host.current().localizedName ?? "Leo 的 MacBook Air",
            "publicKey": key.publicKey.rawRepresentation.base64EncodedString()
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: String])?["error"] ?? "配对失败"
            throw AgentError.executionFailed(message)
        }
        let enrollment = try JSONDecoder().decode(EnrollmentResponse.self, from: data)
        deviceID = enrollment.deviceID
        UserDefaults.standard.set(enrollment.deviceID.uuidString, forKey: "deviceID")
        status = .connecting
        lastMessage = "配对成功，正在连接"
        await connect()
    }

    func connect() async {
        guard let id = deviceID, var components = URLComponents(string: serverURL) else { status = .unpaired; return }
        reconnect?.cancel(); heartbeat?.cancel(); socket?.cancel(with: .goingAway, reason: nil)
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/ws/agent"
        components.queryItems = [URLQueryItem(name: "deviceID", value: id.uuidString.lowercased())]
        guard let url = components.url else { status = .failed("服务器地址无效"); return }
        status = .connecting
        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        task.resume()
        Task { await receiveLoop(task) }
    }

    func disconnectAndForget() {
        heartbeat?.cancel(); reconnect?.cancel(); socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil; deviceID = nil; status = .unpaired; lastMessage = "等待配对"
        UserDefaults.standard.removeObject(forKey: "deviceID")
        KeychainStore.deleteSigningKey()
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        do {
            while !Task.isCancelled {
                let message = try await task.receive()
                let data: Data
                switch message { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: continue }
                try await handle(data, task: task)
            }
        } catch {
            guard socket === task else { return }
            NSLog("Yaokongtai agent WebSocket error: %@", error.localizedDescription)
            status = .failed("连接中断")
            lastMessage = error.localizedDescription
            scheduleReconnect()
        }
    }

    private func handle(_ data: Data, task: URLSessionWebSocketTask) async throws {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], let type = object["type"] as? String else { throw AgentError.invalidCommand }
        switch type {
        case "server.challenge":
            let challenge = try JSONDecoder().decode(ChallengeMessage.self, from: data)
            guard challenge.protocolVersion == ProtocolVersion.current, let id = deviceID else { throw AgentError.invalidCommand }
            let timestamp = ISO8601DateFormatter().string(from: Date())
            let signature = try KeychainStore.signingKey().signature(for: Data("\(challenge.challenge)|\(timestamp)|1".utf8)).base64EncodedString()
            try await send(["type": "agent.authenticate", "deviceID": id.uuidString.lowercased(), "signature": signature, "timestamp": timestamp], task: task)
        case "server.authenticated":
            status = .connected; lastMessage = "安全连接已建立"
            try await sendSnapshot(task: task)
            startHeartbeat(task)
        case "server.command":
            let envelope = try JSONDecoder.agent.decode(ServerCommandMessage.self, from: data)
            do {
                try controller.execute(envelope.command)
                try await send(["type": "agent.result", "commandID": envelope.command.id.uuidString.lowercased(), "ok": true, "code": "OK", "message": "操作完成"], task: task)
                lastMessage = "已执行 \(envelope.command.type)"
            } catch {
                let agentError = error as? AgentError ?? .executionFailed(error.localizedDescription)
                try await send(["type": "agent.result", "commandID": envelope.command.id.uuidString.lowercased(), "ok": false, "code": agentError.code, "message": agentError.localizedDescription], task: task)
                lastMessage = agentError.localizedDescription
            }
            try await sendSnapshot(task: task)
        case "server.error":
            lastMessage = object["message"] as? String ?? "中继拒绝了消息"
            NSLog("Yaokongtai relay rejected message: %@", lastMessage)
        default: break
        }
    }

    private func startHeartbeat(_ task: URLSessionWebSocketTask) {
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard let self, self.status == .connected else { break }
                try? await self.sendSnapshot(task: task)
            }
        }
    }

    private func sendSnapshot(task: URLSessionWebSocketTask) async throws {
        guard let id = deviceID else { return }
        let snapshot = controller.snapshot(deviceID: id)
        let data = try JSONEncoder.agent.encode(snapshot)
        var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        object["deviceID"] = id.uuidString.lowercased()
        var controls = object["controls"] as? [String: Any] ?? [:]
        for key in ["wifi", "bluetooth", "focus", "darkMode", "brightness", "volume", "muted"] where controls[key] == nil {
            controls[key] = NSNull()
        }
        object["controls"] = controls
        try await send(["type": "agent.snapshot", "snapshot": object], task: task)
    }

    private func send(_ object: [String: Any], task: URLSessionWebSocketTask) async throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        try await task.send(.data(data))
    }

    private func scheduleReconnect() {
        reconnect?.cancel()
        reconnect = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, self.deviceID != nil else { return }
            await self.connect()
        }
    }
}
