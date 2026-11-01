import Foundation
import Security
import Darwin

let serviceName = "io.github.aacs111.envguardcc.timezone"
let installedDaemon = "/Library/PrivilegedHelperTools/" + serviceName
let installedPlist = "/Library/LaunchDaemons/" + serviceName + ".plist"

@objc protocol TimezoneServiceProtocol {
    func ping(withReply reply: @escaping (Bool, String) -> Void)
    func configure(_ zone: String, automatic: Bool, withReply reply: @escaping (Bool, String) -> Void)
    func uninstall(withReply reply: @escaping (Bool, String) -> Void)
}

func validZone(_ zone: String) -> Bool {
    guard zone.utf8.count <= 128, !zone.contains(".."),
          zone.range(of: "^[A-Za-z][A-Za-z0-9_+/\\-]*$", options: .regularExpression) != nil,
          TimeZone(identifier: zone) != nil else { return false }
    let root = URL(fileURLWithPath: "/var/db/timezone/zoneinfo").resolvingSymlinksInPath().path
    let file = URL(fileURLWithPath: root).appendingPathComponent(zone).resolvingSymlinksInPath().path
    return file.hasPrefix(root + "/") && FileManager.default.fileExists(atPath: file)
}

func codeRequirement(_ executable: String) throws -> String {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: executable) as CFURL, [], &code) == errSecSuccess,
          let code = code, SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else {
        throw NSError(domain: "TimezoneService", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid helper signature"])
    }
    var requirement: SecRequirement?
    var text: CFString?
    guard SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess,
          let requirement = requirement, SecRequirementCopyString(requirement, [], &text) == errSecSuccess,
          let text = text else { throw NSError(domain: "TimezoneService", code: 2) }
    return text as String
}

func rootOwned(_ path: String, directory: Bool = false) -> Bool {
    var info = stat()
    guard lstat(path, &info) == 0, info.st_uid == 0, info.st_mode & 0o022 == 0 else { return false }
    return info.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG)
}

func fixedCommand(_ executable: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    let ended = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in ended.signal() }
    try process.run()
    if ended.wait(timeout: .now() + 20) == .timedOut {
        process.terminate()
        if ended.wait(timeout: .now() + 2) == .timedOut { kill(process.processIdentifier, SIGKILL) }
        throw NSError(domain: "TimezoneService", code: 3, userInfo: [NSLocalizedDescriptionKey: "System operation timed out"])
    }
    guard process.terminationStatus == 0 else {
        throw NSError(domain: "TimezoneService", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "System operation failed; original backup retained"])
    }
}
