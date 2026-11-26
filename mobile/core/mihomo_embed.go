//go:build mihomo_embed

package envguardcore

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/hub/executor"
)

type embeddedKernel struct {
	running bool
	homeDir string
}

func newKernelBackend(stateDir string) kernelBackend {
	return &embeddedKernel{
		homeDir: filepath.Join(stateDir, "mihomo"),
	}
}

func (k *embeddedKernel) Apply(yamlConfig string) error {
	if err := os.MkdirAll(k.homeDir, 0o700); err != nil {
		return err
	}
	constant.SetHomeDir(k.homeDir)
	cfgPath := filepath.Join(k.homeDir, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte(yamlConfig), 0o600); err != nil {
		return err
	}
	parsed, err := executor.ParseWithBytes([]byte(yamlConfig))
	if err != nil {
		return fmt.Errorf("mihomo 配置解析失败：%w", err)
	}
	executor.ApplyConfig(parsed, true)
	k.running = true
	return nil
}

func (k *embeddedKernel) Stop() error {
	if !k.running {
		return nil
	}
	executor.Shutdown()
	k.running = false
	return nil
}

func (k *embeddedKernel) IsRunning() bool {
	return k.running
}
