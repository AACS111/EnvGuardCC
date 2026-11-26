package envguardcore

import (
	"runtime"
	"runtime/debug"
)

// MemoryGuardProfile configures Go GC and buffer budgets.
// On iOS Network Extensions (NEPacketTunnelProvider), Jetsam enforces a hard ~50 MiB limit;
// setting a 35 MiB soft memory limit and aggressive GC keeps headroom for packet buffers.
type MemoryGuardProfile struct {
	SoftLimitMB        int
	GCPercent          int
	MaxConnectionItems int
}

func defaultMemoryProfile(platform string, requestedLimitMB int) MemoryGuardProfile {
	if requestedLimitMB > 0 {
		maxConn := 500
		gc := 50
		if requestedLimitMB <= 40 {
			maxConn = 120
			gc = 20
		}
		return MemoryGuardProfile{
			SoftLimitMB:        requestedLimitMB,
			GCPercent:          gc,
			MaxConnectionItems: maxConn,
		}
	}
	if platform == "ios" {
		return MemoryGuardProfile{
			SoftLimitMB:        35,
			GCPercent:          20,
			MaxConnectionItems: 120,
		}
	}
	return MemoryGuardProfile{
		SoftLimitMB:        128,
		GCPercent:          60,
		MaxConnectionItems: 600,
	}
}

func applyMemoryGuard(profile MemoryGuardProfile) {
	if profile.GCPercent > 0 {
		debug.SetGCPercent(profile.GCPercent)
	}
	if profile.SoftLimitMB > 0 {
		debug.SetMemoryLimit(int64(profile.SoftLimitMB) * 1024 * 1024)
	}
	runtime.GC()
}
