import { gatewayUrl } from './local-helper';

export type AppUpdate = {
  currentVersion: string | null; platform: string; arch: string; checkedAt: string;
  status: 'available' | 'current' | 'pending' | 'unsupported' | 'no-release' | 'error';
  latestVersion?: string; releasesUrl: string | null; releaseUrl?: string;
  notes?: string; downloadUrl?: string; assetName?: string;
  error?: 'rate-limit' | 'invalid-release' | 'configuration' | 'network';
};

export async function readAppUpdate(force = false): Promise<AppUpdate> {
  const response = await fetch(`${gatewayUrl}/__checkcc/updates${force ? '?force=1' : ''}`, {
    headers: { 'X-CheckCC-Client': 'gateway-ui' },
    signal: AbortSignal.timeout(15000), cache: 'no-store',
  });
  if (!response.ok) throw new Error('更新检查服务暂不可用。');
  return response.json();
}
