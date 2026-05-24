export const PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'moonshot',
  'deepseek',
] as const;

export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  mistral: 'Mistral',
  moonshot: 'Moonshot (Kimi)',
  deepseek: 'DeepSeek',
};

export interface ModelInfo {
  id: string;
  context?: number;
  input?: number;
  output?: number;
  tools?: boolean;
  reasoning?: boolean;
}

export interface ProviderInfo {
  baseUrl: string;
  listEndpoint: string;
  models: ModelInfo[];
}

export const LLM_HOSTS = new Set<string>([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.moonshot.ai',
  'api.moonshot.cn',
  'api.deepseek.com',
]);