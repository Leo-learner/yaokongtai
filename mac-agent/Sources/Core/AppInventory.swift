import AppKit

final class AppInventory: @unchecked Sendable {
    private let protectedBundleIDs: Set<String> = [
        "com.apple.finder", "com.apple.dock", "com.apple.controlcenter", "com.apple.systemuiserver",
        "com.apple.loginwindow", "com.dkz12345.yaokongtai.agent"
    ]

    func list() -> [InstalledApp] {
        let running = Dictionary(grouping: NSWorkspace.shared.runningApplications.compactMap { app -> (String, Bool)? in
            guard let id = app.bundleIdentifier else { return nil }; return (id, !app.isTerminated)
        }, by: \.0).mapValues { $0.contains(where: \.1) }
        var found: [String: InstalledApp] = [:]
        for root in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"] {
            guard let enumerator = FileManager.default.enumerator(at: URL(fileURLWithPath: root), includingPropertiesForKeys: [.isApplicationKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            for case let url as URL in enumerator where url.pathExtension == "app" {
                guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier,
                      id.range(of: #"^[A-Za-z0-9._-]{3,255}$"#, options: .regularExpression) != nil,
                      bundle.object(forInfoDictionaryKey: "LSBackgroundOnly") as? Bool != true else { continue }
                let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? url.deletingPathExtension().lastPathComponent
                found[id] = InstalledApp(bundleID: id, name: String(name.prefix(120)), running: running[id] == true, protected: protectedBundleIDs.contains(id), icon: nil)
            }
        }
        return Array(found.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }.prefix(500))
    }

    func execute(type: String, bundleID: String) throws {
        let apps = list()
        guard let app = apps.first(where: { $0.bundleID == bundleID }) else { throw AgentError.unknownApplication }
        switch type {
        case "app.launch":
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { throw AgentError.unknownApplication }
            NSWorkspace.shared.openApplication(at: url, configuration: .init())
        case "app.quit", "app.forceQuit":
            if app.protected { throw AgentError.protectedApplication }
            let instances = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            let sent = instances.map { type == "app.forceQuit" ? $0.forceTerminate() : $0.terminate() }.contains(true)
            if !sent && !instances.isEmpty { throw AgentError.executionFailed("退出请求未被应用接受") }
        default: throw AgentError.invalidCommand
        }
    }

}
