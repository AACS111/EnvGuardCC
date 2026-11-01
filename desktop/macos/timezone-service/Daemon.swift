import Foundation
import SystemConfiguration
import Darwin

// ClientRequirement.swift is generated from the signed bridge's exact cdhash.
final class Service: NSObject, TimezoneServiceProtocol {
    static let operations = DispatchQueue(label: "timezone-service-operations")
    let user: uid_t
    init(user: uid_t) { self.user = user }
    func authorized() -> Bool {
        var console: uid_t = 0
        guard let name = SCDynamicStoreCopyConsoleUser(nil, &console, nil) else { return false }
        return name as String != "loginwindow" && console != 0 && console == user
    }
    func ping(withReply reply: @escaping (Bool, String) -> Void) {
        reply(authorized(), authorized() ? "Timezone service ready" : "Active console user required")
    }
    func configure(_ zone: String, automatic: Bool, withReply reply: @escaping (Bool, String) -> Void) {
        Self.operations.async {
            guard self.authorized(), validZone(zone) else { reply(false, "Unauthorized or invalid timezone"); return }
            do {
                try fixedCommand("/usr/bin/defaults", ["write", "/Library/Preferences/com.apple.timezone.auto", "Active", "-bool", "false"])
                try fixedCommand("/usr/sbin/systemsetup", ["-settimezone", zone])
                if automatic { try fixedCommand("/usr/bin/defaults", ["write", "/Library/Preferences/com.apple.timezone.auto", "Active", "-bool", "true"]) }
                reply(true, "Timezone configuration applied; caller must verify system state")
            } catch { reply(false, error.localizedDescription) }
        }
    }
    func uninstall(withReply reply: @escaping (Bool, String) -> Void) {
        Self.operations.async {
            guard self.authorized() else { reply(false, "Active console user required"); return }
            do {
                try FileManager.default.removeItem(atPath: installedPlist)
                try FileManager.default.removeItem(atPath: installedDaemon)
                reply(true, "Timezone service removed")
                Self.operations.asyncAfter(deadline: .now() + 1) {
                    try? fixedCommand("/bin/launchctl", ["bootout", "system/" + serviceName])
                    exit(0)
                }
            } catch { reply(false, error.localizedDescription) }
        }
    }
}

final class Listener: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard connection.effectiveUserIdentifier != 0 else { return false }
        // XPC enforces this against peer code identity for every incoming message;
        // do not use PID-based checks (PID reuse) or a local TCP port.
        connection.setCodeSigningRequirement(clientRequirement)
        connection.exportedInterface = NSXPCInterface(with: TimezoneServiceProtocol.self)
        connection.exportedObject = Service(user: connection.effectiveUserIdentifier)
        connection.resume()
        return true
    }
}

@main struct Daemon {
    static func main() {
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--validate-zone" {
            print(validZone(CommandLine.arguments[2]) ? "valid" : "invalid"); return
        }
        guard geteuid() == 0, rootOwned(installedDaemon), rootOwned(installedPlist) else { exit(1) }
        let listener = NSXPCListener(machServiceName: serviceName)
        let delegate = Listener()
        listener.delegate = delegate
        listener.resume()
        withExtendedLifetime(delegate) { dispatchMain() }
    }
}
