import AppKit
import ServiceManagement
import Sparkle
import SwiftUI

@MainActor
final class AgentModel: ObservableObject {
    @Published var pairingCode = ""
    @Published var errorMessage = ""
    @Published var launchAtLogin = SMAppService.mainApp.status == .enabled
    let connection = AgentConnection()
    let system = SystemController()
    let updater: SPUStandardUpdaterController

    init() {
        updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    }

    func pair() {
        let code = pairingCode
        Task { do { try await connection.pair(code: code); pairingCode = "" } catch { errorMessage = error.localizedDescription } }
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            launchAtLogin = SMAppService.mainApp.status == .enabled
        } catch { errorMessage = error.localizedDescription; launchAtLogin = SMAppService.mainApp.status == .enabled }
    }

    func openWeb() {
        if let url = URL(string: connection.serverURL) { NSWorkspace.shared.open(url) }
    }
}
