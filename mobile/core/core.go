package envguardcore

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SocketProtector is implemented by Android VpnService (calling VpnService.protect(fd))
// so outbound proxy sockets bypass the VPN interface and never loop back into TUN.
type SocketProtector interface {
	Protect(fd int) bool
}

// VpnDelegate lets the Go core ask Android/iOS host layers to start or stop the OS VPN tunnel.
type VpnDelegate interface {
	RequestStartVPN() error
	RequestStopVPN() error
	ReadSystemTimezone() string
}

type kernelBackend interface {
	Apply(yamlConfig string) error
	Stop() error
	IsRunning() bool
}

type ProtectionTarget struct {
	IP              string  `json:"ip"`
	CountryCode     string  `json:"countryCode"`
	CountryName     string  `json:"countryName"`
	City            *string `json:"city"`
	Timezone        *string `json:"timezone"`
	WindowsTimezone *string `json:"windowsTimezone"`
	Language        string  `json:"language"`
	Locale          string  `json:"locale"`
}

type ExitHistoryEntry struct {
	IP          string  `json:"ip"`
	At          string  `json:"at"`
	CountryCode *string `json:"countryCode,omitempty"`
}

// MobileCore is the unified mobile runtime shared by Android (.aar) and iOS (.xcframework).
type MobileCore struct {
	mu sync.RWMutex

	stateDir   string
	appVersion string
	platform   string // android | ios
	arch       string
	memProfile MemoryGuardProfile

	helperPort     int
	gatewayPort    int
	mixedPort      int
	controllerPort int
	controllerKey  string
	helperToken    string

	helperServer  *http.Server
	gatewayServer *http.Server

	kernel      kernelBackend
	protector   SocketProtector
	vpnDelegate VpnDelegate

	sources      *SourceStore
	networkCfg   LocalNetworkConfig
	egressMode   string // rule | global | direct
	failureMode  string // claude | all
	tunEnabled   bool
	tunFD        int
	tunMTU       int
	restarts     int

	protectionEnabled bool
	desiredEnabled    bool
	protectionPhase   string // idle | starting | active | stopping
	target            *ProtectionTarget
	cloakEnabled      bool
	cloakUpdatedAt    string
	monitoring        bool
	intervalMs        int
	history           []map[string]string
	delays            map[string]*int
	exitHistory       []ExitHistoryEntry
	regionLocked      bool
	regionLockReason  string
	regionLockCountry string
	regionLockIP      string
}

var (
	globalMu   sync.Mutex
	globalCore *MobileCore
)

// StartCore initializes the mobile core, memory guard, persisted sources, and loopback APIs.
// Exported for gomobile bind (Android AAR & iOS XCFramework).
func StartCore(stateDir, appVersion, platform, arch string, memoryLimitMB int) error {
	globalMu.Lock()
	defer globalMu.Unlock()
	if globalCore != nil {
		return nil
	}
	core, err := NewMobileCore(stateDir, appVersion, platform, arch, memoryLimitMB)
	if err != nil {
		return err
	}
	if err := core.StartServers(39081, 39082); err != nil {
		return err
	}
	globalCore = core
	return nil
}

// StopCore gracefully tears down VPN tunnel, mihomo kernel, and loopback servers.
func StopCore() error {
	globalMu.Lock()
	core := globalCore
	globalCore = nil
	globalMu.Unlock()
	if core == nil {
		return nil
	}
	return core.Close()
}

// SetSocketProtector registers Android VpnService.protect callback.
func SetSocketProtector(p SocketProtector) {
	globalMu.Lock()
	core := globalCore
	globalMu.Unlock()
	if core != nil {
		core.mu.Lock()
		core.protector = p
		core.mu.Unlock()
	}
}

// SetVpnDelegate registers the native Android/iOS VPN lifecycle & timezone delegate.
func SetVpnDelegate(d VpnDelegate) {
	globalMu.Lock()
	core := globalCore
	globalMu.Unlock()
	if core != nil {
		core.mu.Lock()
		core.vpnDelegate = d
		core.mu.Unlock()
	}
}

// StartTunnel attaches an OS-allocated TUN file descriptor (from Android VpnService or iOS PacketTunnelProvider).
func StartTunnel(tunFd int, mtu int) error {
	globalMu.Lock()
	core := globalCore
	globalMu.Unlock()
	if core == nil {
		return errors.New("core not started")
	}
	return core.AttachTunnel(tunFd, mtu)
}

// StopTunnel detaches TUN and stops kernel takeover while keeping loopback APIs alive.
func StopTunnel() error {
	globalMu.Lock()
	core := globalCore
	globalMu.Unlock()
	if core == nil {
		return nil
	}
	return core.DetachTunnel()
}

// GetHelperPort returns the bound loopback Helper API port.
func GetHelperPort() int {
	globalMu.Lock()
	core := globalCore
	globalMu.Unlock()
	if core == nil {
		return 0
	}
	return core.HelperPort()
}

// GetGatewayPort returns the bound loopback Gateway API port.
func GetGatewayPort() int {
	globalMu.Lock()
	core := globalCore
	globalMu.Unlock()
	if core == nil {
		return 0
	}
	return core.GatewayPort()
}

// GetStatusJSON returns a compact status snapshot for native Android/iOS UI notifications.
func GetStatusJSON() string {
	globalMu.Lock()
	core := globalCore
	globalMu.Unlock()
	if core == nil {
		return `{"running":false}`
	}
	raw, _ := json.Marshal(core.buildNetCoreReport())
	return string(raw)
}

// NewMobileCore creates an isolated MobileCore instance (also used directly in unit tests).
func NewMobileCore(stateDir, appVersion, platform, arch string, memoryLimitMB int) (*MobileCore, error) {
	if stateDir == "" {
		return nil, errors.New("stateDir is required")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	profile := defaultMemoryProfile(platform, memoryLimitMB)
	applyMemoryGuard(profile)

	core := &MobileCore{
		stateDir:        stateDir,
		appVersion:      defaultString(appVersion, "0.2.7"),
		platform:        defaultString(platform, "android"),
		arch:            defaultString(arch, "arm64"),
		memProfile:      profile,
		mixedPort:       39180,
		controllerPort:  39090,
		controllerKey:   randomHex(16),
		helperToken:     randomHex(32),
		kernel:          newKernelBackend(stateDir),
		sources:         loadSourceStore(stateDir),
		egressMode:      "rule",
		failureMode:     "claude",
		protectionPhase: "idle",
		cloakEnabled:    true,
		cloakUpdatedAt:  time.Now().UTC().Format(time.RFC3339),
		intervalMs:      60000,
		delays:          map[string]*int{},
	}
	core.loadNetworkConfig()
	return core, nil
}

func (c *MobileCore) StartServers(preferredHelper, preferredGateway int) error {
	hLn, err := listenLoopback(preferredHelper)
	if err != nil {
		return err
	}
	gLn, err := listenLoopback(preferredGateway)
	if err != nil {
		_ = hLn.Close()
		return err
	}
	c.mu.Lock()
	c.helperPort = hLn.Addr().(*net.TCPAddr).Port
	c.gatewayPort = gLn.Addr().(*net.TCPAddr).Port
	c.helperServer = &http.Server{Handler: c.helperHandler()}
	c.gatewayServer = &http.Server{Handler: c.gatewayHandler()}
	c.mu.Unlock()

	go func() { _ = c.helperServer.Serve(hLn) }()
	go func() { _ = c.gatewayServer.Serve(gLn) }()
	return nil
}

func (c *MobileCore) HelperPort() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.helperPort
}

func (c *MobileCore) GatewayPort() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.gatewayPort
}

func (c *MobileCore) Close() error {
	c.mu.Lock()
	hSrv := c.helperServer
	gSrv := c.gatewayServer
	c.helperServer = nil
	c.gatewayServer = nil
	c.tunEnabled = false
	c.tunFD = 0
	c.mu.Unlock()

	_ = c.kernel.Stop()
	if hSrv != nil {
		_ = hSrv.Close()
	}
	if gSrv != nil {
		_ = gSrv.Close()
	}
	return nil
}

func (c *MobileCore) AttachTunnel(tunFd, mtu int) error {
	c.mu.Lock()
	c.tunFD = tunFd
	if mtu > 0 {
		c.tunMTU = mtu
	}
	c.tunEnabled = true
	c.mu.Unlock()
	return c.applyKernelLocked()
}

func (c *MobileCore) DetachTunnel() error {
	c.mu.Lock()
	c.tunEnabled = false
	c.tunFD = 0
	c.mu.Unlock()
	return c.applyKernelLocked()
}

func (c *MobileCore) applyKernelLocked() error {
	c.mu.Lock()
	active := c.sources.Active()
	if active == nil || len(active.Proxies) == 0 {
		c.mu.Unlock()
		_ = c.kernel.Stop()
		return nil
	}
	// Fail-closed parity with desktop: while protection is off or region is locked,
	// CLAUDE-GUARD stays pointed at REJECT.
	claudeBlocked := !c.protectionEnabled || c.regionLocked
	yamlCfg, err := BuildMihomoConfig(KernelConfigOptions{
		Proxies:        active.Proxies,
		Selected:       active.Selected,
		EgressMode:     c.egressMode,
		MixedPort:      c.mixedPort,
		ControllerPort: c.controllerPort,
		Secret:         c.controllerKey,
		TunEnabled:     c.tunEnabled,
		TunFD:          c.tunFD,
		TunMTU:         c.tunMTU,
		Platform:       c.platform,
		ClaudeBlocked:  claudeBlocked,
		LocalNetwork:   c.networkCfg,
	})
	c.mu.Unlock()
	if err != nil {
		return err
	}
	if err := c.kernel.Apply(yamlCfg); err != nil {
		return err
	}
	c.mu.Lock()
	c.restarts++
	c.mu.Unlock()
	return nil
}

func (c *MobileCore) loadNetworkConfig() {
	raw, err := os.ReadFile(filepath.Join(c.stateDir, "net-core-network.json"))
	if err != nil {
		return
	}
	var cfg LocalNetworkConfig
	if json.Unmarshal(raw, &cfg) == nil {
		c.networkCfg = cfg
	}
}

func (c *MobileCore) saveNetworkConfig(cfg LocalNetworkConfig) error {
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(c.stateDir, "net-core-network.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (c *MobileCore) systemTimezone() string {
	c.mu.RLock()
	d := c.vpnDelegate
	c.mu.RUnlock()
	if d != nil {
		if tz := d.ReadSystemTimezone(); tz != "" {
			return tz
		}
	}
	name, _ := time.Now().Zone()
	if tzEnv := os.Getenv("TZ"); tzEnv != "" {
		return tzEnv
	}
	if loc := time.Local.String(); loc != "" && loc != "Local" {
		return loc
	}
	return name
}

func (c *MobileCore) appendHistory(message string) {
	c.history = append([]map[string]string{{
		"at":      time.Now().UTC().Format(time.RFC3339),
		"message": message,
	}}, c.history...)
	if len(c.history) > 40 {
		c.history = c.history[:40]
	}
}

func listenLoopback(preferred int) (net.Listener, error) {
	if preferred > 0 {
		if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferred)); err == nil {
			return ln, nil
		}
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

func randomHex(bytesLen int) string {
	b := make([]byte, bytesLen)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
