import AppKit
import ApplicationServices
import CoreAudio
import AudioToolbox
import CoreBluetooth
import Foundation

final class SystemController: @unchecked Sendable {
    private let apps = AppInventory()
    private let defaults = UserDefaults.standard
    private let brightnessPath = "/opt/homebrew/Cellar/brightness/1.2/bin/brightness"
    private let blueutilPath = "/opt/homebrew/Cellar/blueutil/2.13.0/bin/blueutil"

    func permissionState() -> PermissionState {
        let bluetooth: String
        switch CBManager.authorization {
        case .allowedAlways: bluetooth = "authorized"
        case .denied, .restricted: bluetooth = "denied"
        default: bluetooth = "unknown"
        }
        return PermissionState(
            accessibility: AXIsProcessTrusted() ? "authorized" : "denied",
            automation: defaults.bool(forKey: "automationAuthorized") ? "authorized" : "unknown",
            bluetooth: bluetooth,
            brightness: FileManager.default.isExecutableFile(atPath: brightnessPath) ? "available" : "unavailable"
        )
    }

    func requestAccessibilityPermission() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    func snapshot(deviceID: UUID) -> DeviceSnapshot {
        let permissions = permissionState()
        return DeviceSnapshot(
            deviceID: deviceID,
            deviceName: Host.current().localizedName ?? "Leo 的 MacBook Air",
            online: true,
            lastSeenAt: Date(),
            apps: apps.list(),
            controls: ControlState(
                wifi: wifiState(), bluetooth: permissions.bluetooth == "denied" ? nil : booleanOutput(path: blueutilPath, arguments: ["--power"]),
                focus: focusState(),
                darkMode: darkModeState(), brightness: brightnessState(),
                volume: volumeState()?.volume, muted: volumeState()?.muted
            ),
            permissions: permissions, agentVersion: ProtocolVersion.agentVersion, protocolVersion: ProtocolVersion.current
        )
    }

    func execute(_ command: RemoteCommand) throws {
        guard command.protocolVersion == ProtocolVersion.current else { throw AgentError.invalidCommand }
        guard command.isFresh else { throw AgentError.expiredCommand }
        if isHighImpact(command), command.elevationToken?.isEmpty != false { throw AgentError.permissionDenied }
        switch command.type {
        case "app.launch", "app.quit", "app.forceQuit":
            guard let bundleID = command.payload.bundleID, bundleID.range(of: #"^[A-Za-z0-9._-]{3,255}$"#, options: .regularExpression) != nil else { throw AgentError.invalidCommand }
            try apps.execute(type: command.type, bundleID: bundleID)
        case "system.volume":
            guard let value = command.payload.value, 0...1 ~= value else { throw AgentError.invalidCommand }
            try setVolume(value)
        case "system.mute":
            guard let enabled = command.payload.enabled else { throw AgentError.invalidCommand }
            try setMute(enabled)
        case "system.brightness":
            guard let value = command.payload.value, 0...1 ~= value else { throw AgentError.invalidCommand }
            _ = try run(path: brightnessPath, arguments: [String(format: "%.3f", value)])
        case "system.bluetooth":
            guard let enabled = command.payload.enabled else { throw AgentError.invalidCommand }
            _ = try run(path: blueutilPath, arguments: ["--power", enabled ? "1" : "0"])
        case "system.wifi":
            guard let enabled = command.payload.enabled, let device = wifiDevice() else { throw AgentError.unsupported }
            _ = try run(path: "/usr/sbin/networksetup", arguments: ["-setairportpower", device, enabled ? "on" : "off"])
        case "system.darkMode":
            guard let enabled = command.payload.enabled else { throw AgentError.invalidCommand }
            try automation(#"tell application "System Events" to tell appearance preferences to set dark mode to "# + (enabled ? "true" : "false"))
        case "system.focus":
            guard let enabled = command.payload.enabled else { throw AgentError.invalidCommand }
            _ = try run(path: "/usr/bin/shortcuts", arguments: ["run", enabled ? "遥控台·开启勿扰" : "遥控台·关闭勿扰"])
            defaults.set(enabled, forKey: "lastFocusState")
        case "media.previous": try mediaKey(20)
        case "media.playPause": try mediaKey(16)
        case "media.next": try mediaKey(19)
        case "system.lock": try keyEvent(keyCode: 12, flags: [.maskCommand, .maskControl])
        case "system.sleep": try automation(#"tell application "System Events" to sleep"#)
        default: throw AgentError.invalidCommand
        }
    }

    private func isHighImpact(_ command: RemoteCommand) -> Bool {
        ["app.forceQuit", "system.lock", "system.sleep"].contains(command.type) || (command.type == "system.wifi" && command.payload.enabled == false)
    }

    private func run(path: String, arguments: [String]) throws -> String {
        guard FileManager.default.isExecutableFile(atPath: path) else { throw AgentError.unsupported }
        let process = Process()
        let output = Pipe(), error = Pipe()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = error
        do { try process.run(); process.waitUntilExit() } catch { throw AgentError.executionFailed(error.localizedDescription) }
        let stdout = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if process.terminationStatus != 0 {
            let stderr = String(decoding: error.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw AgentError.executionFailed(stderr.isEmpty ? "系统命令失败（\(process.terminationStatus)）" : stderr)
        }
        return stdout
    }

    private func booleanOutput(path: String, arguments: [String]) -> Bool? {
        guard let output = try? run(path: path, arguments: arguments) else { return nil }
        return output == "1" || output.localizedCaseInsensitiveContains("on")
    }

    private func wifiDevice() -> String? {
        guard let output = try? run(path: "/usr/sbin/networksetup", arguments: ["-listallhardwareports"]) else { return nil }
        let lines = output.components(separatedBy: .newlines)
        for index in lines.indices where lines[index].contains("Hardware Port: Wi-Fi") {
            guard index + 1 < lines.count else { continue }
            let parts = lines[index + 1].components(separatedBy: "Device:")
            if parts.count == 2 { return parts[1].trimmingCharacters(in: .whitespaces) }
        }
        return nil
    }

    private func wifiState() -> Bool? {
        guard let device = wifiDevice(), let output = try? run(path: "/usr/sbin/networksetup", arguments: ["-getairportpower", device]) else { return nil }
        return output.localizedCaseInsensitiveContains("on")
    }

    private func focusState() -> Bool? {
        guard let output = try? run(path: "/usr/bin/shortcuts", arguments: ["list"]),
              output.components(separatedBy: .newlines).contains("遥控台·开启勿扰"),
              output.components(separatedBy: .newlines).contains("遥控台·关闭勿扰") else { return nil }
        return defaults.object(forKey: "lastFocusState") as? Bool ?? false
    }

    private func brightnessState() -> Double? {
        guard let output = try? run(path: brightnessPath, arguments: ["-l"]),
              let range = output.range(of: #"brightness\s+([0-9.]+)"#, options: .regularExpression) else { return nil }
        return Double(output[range].split(separator: " ").last ?? "")
    }

    private func darkModeState() -> Bool? {
        let script = #"tell application "System Events" to tell appearance preferences to get dark mode"#
        guard let output = try? run(path: "/usr/bin/osascript", arguments: ["-e", script]) else { return nil }
        defaults.set(true, forKey: "automationAuthorized")
        return output == "true"
    }

    private func automation(_ script: String) throws {
        do { _ = try run(path: "/usr/bin/osascript", arguments: ["-e", script]); defaults.set(true, forKey: "automationAuthorized") }
        catch { defaults.set(false, forKey: "automationAuthorized"); throw error }
    }

    private func audioDevice() -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr ? device : nil
    }

    private func volumeState() -> (volume: Double, muted: Bool)? {
        guard let device = audioDevice() else { return nil }
        var volumeAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        var muteAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        var volume = Float32(0), mute = UInt32(0)
        var volumeSize = UInt32(MemoryLayout<Float32>.size), muteSize = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &volumeAddress, 0, nil, &volumeSize, &volume) == noErr else { return nil }
        _ = AudioObjectGetPropertyData(device, &muteAddress, 0, nil, &muteSize, &mute)
        return (Double(volume), mute != 0)
    }

    private func setVolume(_ value: Double) throws {
        guard let device = audioDevice() else { throw AgentError.unsupported }
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        var level = Float32(value)
        guard AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &level) == noErr else { throw AgentError.executionFailed("无法修改音量") }
    }

    private func setMute(_ enabled: Bool) throws {
        guard let device = audioDevice() else { throw AgentError.unsupported }
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = enabled ? 1 : 0
        guard AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value) == noErr else { throw AgentError.executionFailed("无法修改静音状态") }
    }

    private func mediaKey(_ keyCode: Int) throws {
        guard AXIsProcessTrusted() else { throw AgentError.permissionDenied }
        for isDown in [true, false] {
            let flags = isDown ? 0xA00 : 0xB00
            let data1 = (keyCode << 16) | flags
            guard let event = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: -1),
                  let cgEvent = event.cgEvent else { throw AgentError.executionFailed("无法创建媒体键事件") }
            cgEvent.post(tap: .cghidEventTap)
        }
    }
    private func keyEvent(keyCode: CGKeyCode, flags: CGEventFlags) throws {
        guard AXIsProcessTrusted() else { throw AgentError.permissionDenied }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else { throw AgentError.executionFailed("无法创建键盘事件") }
        down.flags = flags; up.flags = flags; down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    }
}
