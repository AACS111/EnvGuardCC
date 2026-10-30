// EnvGuardCC 的检测服务配置，用于控制外部 IP 情报等后端检测服务的开关、接口和超时时间。
import type { DetectionServiceConfig } from "./types";

export const serviceConfig: Record<string, DetectionServiceConfig> = {
  gateway: { enabled: true, endpoint: "http://127.0.0.1:3010/__checkcc/diagnostics", timeoutMs: 8500 },
  ipIntel: {
    enabled: false,
    endpoint: "/api/ip-intel",
    timeoutMs: 3500,
  },
};
