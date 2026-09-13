import Foundation

enum ProtocolVersion {
    static let current = 1
    static let agentVersion = "0.1.0"
}

struct RemoteCommand: Codable, Equatable, Sendable {
    struct Payload: Codable, Equatable, Sendable {
        var bundleID: String?
        var enabled: Bool?
        var value: Double?
    }
    let id: UUID
    let protocolVersion: Int
    let type: String
    let payload: Payload
    let issuedAt: Date
    let expiresAt: Date
    let elevationToken: String?

    var isFresh: Bool {
        let now = Date()
        return protocolVersion == ProtocolVersion.current && issuedAt <= now.addingTimeInterval(5) && expiresAt > now && expiresAt.timeIntervalSince(issuedAt) <= 10
    }
}

struct InstalledApp: Codable, Equatable, Sendable, Identifiable {
    var id: String { bundleID }
    let bundleID: String
    let name: String
    let running: Bool
    let protected: Bool
    let icon: String?
}

struct PermissionState: Codable, Equatable, Sendable {
    let accessibility: String
    let automation: String
    let bluetooth: String
    let brightness: String
}

struct ControlState: Codable, Equatable, Sendable {
    let wifi: Bool?
    let bluetooth: Bool?
    let focus: Bool?
    let darkMode: Bool?
    let brightness: Double?
    let volume: Double?
    let muted: Bool?
}

struct DeviceSnapshot: Codable, Equatable, Sendable {
    let deviceID: UUID
    let deviceName: String
    let online: Bool
    let lastSeenAt: Date
    let apps: [InstalledApp]
    let controls: ControlState
    let permissions: PermissionState
    let agentVersion: String
    let protocolVersion: Int
}

struct ChallengeMessage: Decodable { let type: String; let challenge: String; let protocolVersion: Int }
struct ServerCommandMessage: Decodable { let type: String; let command: RemoteCommand }
struct EnrollmentResponse: Decodable { let deviceID: UUID; let websocketURL: URL }

enum AgentError: Error, LocalizedError, Equatable {
    case invalidCommand, expiredCommand, protectedApplication, unknownApplication, unsupported, permissionDenied, executionFailed(String)
    var errorDescription: String? {
        switch self {
        case .invalidCommand: "无效命令"
        case .expiredCommand: "命令已过期"
        case .protectedApplication: "系统应用受到保护"
        case .unknownApplication: "应用未由代理登记"
        case .unsupported: "当前系统版本不支持此操作"
        case .permissionDenied: "缺少系统权限"
        case .executionFailed(let message): message
        }
    }
    var code: String {
        switch self {
        case .invalidCommand: "INVALID_COMMAND"
        case .expiredCommand: "COMMAND_EXPIRED"
        case .protectedApplication: "PROTECTED_APPLICATION"
        case .unknownApplication: "INVALID_COMMAND"
        case .unsupported: "UNSUPPORTED"
        case .permissionDenied: "PERMISSION_DENIED"
        case .executionFailed: "EXECUTION_FAILED"
        }
    }
}

extension JSONEncoder {
    static let agent: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
}
extension JSONDecoder {
    static let agent: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
