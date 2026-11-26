//go:build !mihomo_embed

package envguardcore

import (
	"os"
	"path/filepath"
)

// stubKernel is used for fast unit tests without linking the full mihomo binary.
// Production Android/iOS builds pass `-tags mihomo_embed`.
type stubKernel struct {
	running  bool
	lastYAML string
	homeDir  string
}

func newKernelBackend(stateDir string) kernelBackend {
	return &stubKernel{homeDir: filepath.Join(stateDir, "mihomo")}
}

func (k *stubKernel) Apply(yamlConfig string) error {
	if err := os.MkdirAll(k.homeDir, 0o700); err != nil {
		return err
	}
	_ = os.WriteFile(filepath.Join(k.homeDir, "config.yaml"), []byte(yamlConfig), 0o600)
	k.lastYAML = yamlConfig
	k.running = true
	return nil
}

func (k *stubKernel) Stop() error {
	k.running = false
	return nil
}

func (k *stubKernel) IsRunning() bool {
	return k.running
}
