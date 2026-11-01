import Foundation
import Darwin

func output(_ state: String, _ detail: String, ok: Bool = true) {
    let data = try! JSONSerialization.data(withJSONObject: ["state": state, "detail": detail, "ok": ok, "protocol": 1], options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

@main struct Bridge {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let action = args.first, ["status", "set", "uninstall"].contains(action) else {
            output("invalid", "Unsupported action", ok: false); exit(1)
        }
        if action == "set" && (args.count != 3 || !validZone(args[1]) || !["true", "false"].contains(args[2])) {
            output("invalid", "Invalid timezone request", ok: false); exit(1)
        }
        guard FileManager.default.fileExists(atPath: installedDaemon) else {
            output("notInstalled", "Timezone service is not installed", ok: action == "status"); exit(action == "status" ? 0 : 1)
        }
        guard rootOwned("/Library/PrivilegedHelperTools", directory: true), rootOwned("/Library/LaunchDaemons", directory: true),
              rootOwned(installedDaemon), rootOwned(installedPlist), let requirement = try? codeRequirement(installedDaemon) else {
            output("unavailable", "Installed service ownership or signature is invalid", ok: false); exit(1)
        }
        let connection = NSXPCConnection(machServiceName: serviceName, options: .privileged)
        connection.remoteObjectInterface = NSXPCInterface(with: TimezoneServiceProtocol.self)
        connection.setCodeSigningRequirement(requirement)
        connection.resume()
        let proxy = connection.remoteObjectProxyWithErrorHandler { _ in
            output("updateRequired", "Service unavailable or this build needs administrator approval again", ok: false); exit(1)
        } as! TimezoneServiceProtocol
        let reply: (Bool, String) -> Void = { success, detail in
            output(success ? (action == "uninstall" ? "notInstalled" : "ready") : "unavailable", detail, ok: success)
            connection.invalidate(); exit(success ? 0 : 1)
        }
        switch action {
        case "status": proxy.ping(withReply: reply)
        case "set": proxy.configure(args[1], automatic: args[2] == "true", withReply: reply)
        default: proxy.uninstall(withReply: reply)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 55) {
            output("unavailable", "Timezone service did not respond", ok: false); exit(1)
        }
        dispatchMain()
    }
}
