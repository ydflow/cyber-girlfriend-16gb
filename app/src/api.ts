export type ServiceConfig = {
  deepseekConfigured: boolean;
  volcanoAsrConfigured: boolean;
  volcanoTtsConfigured: boolean;
  volcanoCredentialMode: 'apiKey' | 'legacy';
  volcanoAppId: string;
  asrResourceId: string;
  ttsCluster: string;
  ttsVoiceType: string;
};

export const EMPTY_SERVICE_CONFIG: ServiceConfig = {
  deepseekConfigured: false,
  volcanoAsrConfigured: false,
  volcanoTtsConfigured: false,
  volcanoCredentialMode: 'apiKey',
  volcanoAppId: '',
  asrResourceId: 'volc.bigasr.auc_turbo',
  ttsCluster: 'volcano_tts',
  ttsVoiceType: '',
};

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `请求失败（${response.status}）`);
  }
  return payload;
}

export async function getServiceConfig(): Promise<ServiceConfig> {
  return apiRequest<ServiceConfig>('/api/config');
}
