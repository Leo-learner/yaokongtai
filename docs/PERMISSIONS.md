# macOS permissions and compatibility

| Capability | Adapter | Permission | Notes |
|---|---|---|---|
| List, launch, quit apps | AppKit | none | Finder, Dock, Control Center, loginwindow and the agent are protected from quit. |
| Volume and mute | CoreAudio | none | Uses the default output device. |
| Brightness | pinned Homebrew `brightness` executable | local executable | Uses an undocumented Apple Silicon path and can become unavailable after an OS update. |
| Bluetooth | pinned Homebrew `blueutil` executable | Bluetooth | `blueutil` uses private IOBluetooth APIs. |
| Wi-Fi | `/usr/sbin/networksetup` | current user authorization | The wireless device is discovered rather than hard-coded. |
| Media keys and lock | Core Graphics events | Accessibility | Media controls do not read track metadata. |
| Dark mode and sleep | fixed AppleScript | Automation | No caller-supplied script text is accepted. |
| Focus | two fixed Shortcuts | Shortcuts permissions | Create shortcuts named `遥控台·开启勿扰` and `遥控台·关闭勿扰`, each containing the matching Set Focus action. |

The app intentionally runs without App Sandbox because sandboxed processes cannot terminate other applications. It uses Hardened Runtime and a stable Apple Development signature for this single-Mac build.
