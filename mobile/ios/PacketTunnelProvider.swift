import Foundation
import NetworkExtension
import EnvGuardCore

/// iOS Network Extension Packet Tunnel Provider.
///
/// Runs in an isolated OS extension process with a strict ~50 MiB Jetsam memory ceiling.
/// Passes a 35 MiB soft memory budget into EnvGuardCore (Go/mihomo) and shares state
/// with the main Tauri app via the configured App Group container (`ENVGUARD_APP_GROUP` in Info.plist).
final class PacketTunnelProvider: NEPacketTunnelProvider {

    private let tunnelMTU: NSNumber = 1500
    private let extensionMemoryLimitMB: Int = 35

    private func sharedStateDirectory() throws -> URL {
        guard let appGroup = Bundle.main.object(forInfoDictionaryKey: "ENVGUARD_APP_GROUP") as? String,
              !appGroup.isEmpty,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else {
            throw NSError(
                domain: "io.github.aacs111.envguardcc.tunnel",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Missing ENVGUARD_APP_GROUP Info.plist key or App Group entitlement."]
            )
        }
        let stateDir = container.appendingPathComponent("envguard-state", isDirectory: true)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        return stateDir
    }

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        do {
            let stateDir = try sharedStateDirectory()
            let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.2.7"

            var coreError: NSError?
            EnvguardcoreStartCore(stateDir.path, version, "ios", "arm64", extensionMemoryLimitMB, &coreError)
            if let coreError {
                completionHandler(coreError)
                return
            }

            let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "198.18.0.1")
            settings.mtu = tunnelMTU

            let ipv4 = NEIPv4Settings(addresses: ["198.18.0.1"], subnetMasks: ["255.255.0.0"])
            ipv4.includedRoutes = [NEIPv4Route.default()]
            ipv4.excludedRoutes = [
                NEIPv4Route(destinationAddress: "127.0.0.0", subnetMask: "255.0.0.0"),
                NEIPv4Route(destinationAddress: "10.0.0.0", subnetMask: "255.0.0.0"),
                NEIPv4Route(destinationAddress: "172.16.0.0", subnetMask: "255.240.0.0"),
                NEIPv4Route(destinationAddress: "192.168.0.0", subnetMask: "255.255.0.0")
            ]
            settings.ipv4Settings = ipv4

            let dns = NEDNSSettings(servers: ["198.18.0.2"])
            dns.matchDomains = [""]
            settings.dnsSettings = dns

            setTunnelNetworkSettings(settings) { [weak self] error in
                guard let self else { return }
                if let error {
                    completionHandler(error)
                    return
                }
                guard let tunFd = self.resolveTunnelFileDescriptor() else {
                    completionHandler(NSError(
                        domain: "io.github.aacs111.envguardcc.tunnel",
                        code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "Unable to resolve utun file descriptor from NEPacketTunnelProvider."]
                    ))
                    return
                }
                var tunErr: NSError?
                EnvguardcoreStartTunnel(Int(tunFd), self.tunnelMTU.intValue, &tunErr)
                completionHandler(tunErr)
            }
        } catch {
            completionHandler(error)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        var err: NSError?
        EnvguardcoreStopTunnel(&err)
        EnvguardcoreStopCore(&err)
        completionHandler()
    }

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        let status = EnvguardcoreGetStatusJSON()
        completionHandler?(status.data(using: .utf8))
    }

    private func resolveTunnelFileDescriptor() -> Int32? {
        if let fd = packetFlow.value(forKeyPath: "socket.fileDescriptor") as? Int32, fd >= 0 {
            return fd
        }
        return nil
    }
}
