import SwiftUI

@main
struct YaokongtaiAgentApp: App {
    @StateObject private var model = AgentModel()

    var body: some Scene {
        MenuBarExtra("遥控台代理", systemImage: statusIcon) {
            AgentMenu(model: model)
                .frame(width: 330)
        }
        .menuBarExtraStyle(.window)
    }

    private var statusIcon: String {
        switch model.connection.status {
        case .connected: "macbook.and.iphone"
        case .connecting: "arrow.triangle.2.circlepath"
        case .failed: "exclamationmark.triangle"
        case .unpaired: "macbook"
        }
    }
}

struct AgentMenu: View {
    @ObservedObject var model: AgentModel
    @ObservedObject private var connection: AgentConnection

    init(model: AgentModel) { self.model = model; connection = model.connection }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Image(systemName: "macbook.and.iphone").font(.system(size: 25)).foregroundStyle(.blue)
                VStack(alignment: .leading) { Text("遥控台代理").font(.headline); Text(statusText).font(.caption).foregroundStyle(statusColor) }
                Spacer()
            }
            Divider()
            TextField("服务器地址", text: $connection.serverURL)
                .textFieldStyle(.roundedBorder)
                .disabled(connection.status == .connected)
            if connection.deviceID == nil {
                TextField("8 位配对码", text: $model.pairingCode).textFieldStyle(.roundedBorder)
                Button("配对这台 Mac") { model.pair() }.buttonStyle(.borderedProminent).disabled(model.pairingCode.count < 6)
            } else {
                Text(connection.lastMessage).font(.caption).foregroundStyle(.secondary)
                HStack { Button("打开控制网页") { model.openWeb() }; Button("重新连接") { Task { await connection.connect() } }; Spacer(); Button("解除配对", role: .destructive) { connection.disconnectAndForget() } }
            }
            Divider()
            PermissionRow(name: "辅助功能", available: model.system.permissionState().accessibility == "authorized")
            PermissionRow(name: "自动化", available: model.system.permissionState().automation == "authorized")
            PermissionRow(name: "蓝牙", available: model.system.permissionState().bluetooth == "authorized")
            PermissionRow(name: "亮度控制", available: model.system.permissionState().brightness == "available")
            Button("请求辅助功能权限") { model.system.requestAccessibilityPermission() }
            Toggle("登录时启动", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
            HStack { Button("检查更新") { model.updater.checkForUpdates(nil) }; Spacer(); Button("退出") { NSApplication.shared.terminate(nil) } }
            if !model.errorMessage.isEmpty { Text(model.errorMessage).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }.padding(18)
    }

    private var statusText: String {
        switch connection.status { case .connected: "已安全连接"; case .connecting: "正在连接"; case .failed(let message): message; case .unpaired: "等待配对" }
    }
    private var statusColor: Color { connection.status == .connected ? .green : .secondary }
}

private struct PermissionRow: View {
    let name: String; let available: Bool
    var body: some View { HStack { Image(systemName: available ? "checkmark.circle.fill" : "exclamationmark.circle").foregroundStyle(available ? .green : .orange); Text(name); Spacer(); Text(available ? "可用" : "需要检查").foregroundStyle(.secondary) }.font(.caption) }
}
