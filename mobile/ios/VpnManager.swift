import Foundation
import NetworkExtension
import EnvGuardCore

/// Main iOS app controller managing NETunnelProviderManager and the local EnvGuardCore API.
final class EnvGuardVpnManager: NSObject, EnvguardcoreVpnDelegateProtocol {

    private let appGroupId: String
    private let tunnelBundleId: String
    private var manager: NETunnelProviderManager?

    init(appGroupId: String, tunnelBundleId: String) {
        self.appGroupId = appGroupId
        self.tunnelBundleId = tunnelBundleId
        super.init()
    }

    func startLocalCore(appVersion: String) throws {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            throw NSError(
                domain: "io.github.aacs111.envguardcc",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "App Group container unavailable: \(appGroupId)"]
            )
        }
        let stateDir = container.appendingPathComponent("envguard-state", isDirectory: true)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        var err: NSError?
        EnvguardcoreStartCore(stateDir.path, appVersion, "ios", "arm64", 96, &err)
        if let err { throw err }
        EnvguardcoreSetVpnDelegate(self)
    }

    func loadOrCreateProfile(completion: @escaping (Result<NETunnelProviderManager, Error>) -> Void) {
        NETunnelProviderManager.loadAllFromPreferences { [weak self] managers, error in
            guard let self else { return }
            if let error {
                completion(.failure(error))
                return
            }
            let target = managers?.first ?? NETunnelProviderManager()
            let proto = (target.protocolConfiguration as? NETunnelProviderProtocol) ?? NETunnelProviderProtocol()
            proto.providerBundleIdentifier = self.tunnelBundleId
            proto.serverAddress = "EnvGuardCC Local Tunnel"
            target.protocolConfiguration = proto
            target.localizedDescription = "EnvGuardCC"
            target.isEnabled = true

            target.saveToPreferences { saveError in
                if let saveError {
                    completion(.failure(saveError))
                    return
                }
                target.loadFromPreferences { reloadError in
                    if let reloadError {
                        completion(.failure(reloadError))
                        return
                    }
                    self.manager = target
                    completion(.success(target))
                }
            }
        }
    }

    func requestStartVPN() throws {
        let semaphore = DispatchSemaphore(value: 0)
        var startError: Error?
        loadOrCreateProfile { result in
            switch result {
            case .success(let mgr):
                do {
                    try mgr.connection.startVPNTunnel()
                } catch {
                    startError = error
                }
            case .failure(let err):
                startError = err
            }
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 15)
        if let startError {
            throw startError
        }
    }

    func requestStopVPN() throws {
        manager?.connection.stopVPNTunnel()
    }

    func readSystemTimezone() -> String {
        return TimeZone.current.identifier
    }
}
