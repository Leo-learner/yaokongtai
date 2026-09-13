import Foundation
import Security
import CryptoKit

enum KeychainStore {
    private static let service = "com.dkz12345.yaokongtai.agent"
    private static let account = "device-ed25519-key"

    static func signingKey() throws -> Curve25519.Signing.PrivateKey {
        if let data = read() { return try Curve25519.Signing.PrivateKey(rawRepresentation: data) }
        let key = Curve25519.Signing.PrivateKey()
        try save(key.rawRepresentation)
        return key
    }

    static func deleteSigningKey() {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account] as CFDictionary)
    }

    private static func read() -> Data? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ] as CFDictionary, &item)
        guard status == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func save(_ data: Data) throws {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account] as CFDictionary)
        let status = SecItemAdd([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ] as CFDictionary, nil)
        guard status == errSecSuccess else { throw AgentError.executionFailed("无法保存设备密钥（\(status)）") }
    }
}
