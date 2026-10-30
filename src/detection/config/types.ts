// EnvGuardCC 的检测配置类型定义，用于约束运行器、步骤、信号、服务和整体配置结构。
import type { SignalSource } from "../types";

export type DetectionRunnerMode = "sequential" | "parallel" | "grouped";

export type DetectionRunnerConfig = {
  mode: DetectionRunnerMode;
  failFast: boolean;
  defaultTimeoutMs: number;
};

export type DetectionStepConfig = {
  id: string;
  titleKey: string;
  descKey: string;
};

// browser：在浏览器里实测；claude：由 Claude 网关实测（Claude 真正发出的请求/出口）；
// both：两侧都能测，但取值来源不同，用于对比拦截迷惑层是否生效。
export type DetectionEnvironment = "browser" | "claude" | "both";

export type DetectionSignalConfig = {
  enabled: boolean;
  labelKey: string;
  source: SignalSource;
  weight: number;
  order: number;
  environment: DetectionEnvironment;
};

export type DetectionServiceConfig = {
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
};

export type DetectionConfig = {
  runner: DetectionRunnerConfig;
  steps: DetectionStepConfig[];
  signals: Record<string, DetectionSignalConfig>;
  services: Record<string, DetectionServiceConfig>;
};
