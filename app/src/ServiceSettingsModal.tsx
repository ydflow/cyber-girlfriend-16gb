import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  Volume2,
  X,
} from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import {
  apiRequest,
  EMPTY_SERVICE_CONFIG,
  getServiceConfig,
  ServiceConfig,
} from './api';

type EditableConfig = {
  deepseekApiKey: string;
  volcanoApiKey: string;
  volcanoAccessToken: string;
  volcanoCredentialMode: 'apiKey' | 'legacy';
  volcanoAppId: string;
  asrResourceId: string;
  ttsCluster: string;
  ttsVoiceType: string;
};

const EMPTY_FORM: EditableConfig = {
  deepseekApiKey: '',
  volcanoApiKey: '',
  volcanoAccessToken: '',
  volcanoCredentialMode: 'apiKey',
  volcanoAppId: '',
  asrResourceId: 'volc.bigasr.auc_turbo',
  ttsCluster: 'volcano_tts',
  ttsVoiceType: '',
};

function StatusPill({ ready, label }: { ready: boolean; label: string }) {
  return (
    <span className={`service-pill ${ready ? 'is-ready' : ''}`}>
      {ready ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}
      {label}
    </span>
  );
}

export default function ServiceSettingsModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (config: ServiceConfig) => void;
}) {
  const [form, setForm] = useState<EditableConfig>(EMPTY_FORM);
  const [saved, setSaved] = useState<ServiceConfig>(EMPTY_SERVICE_CONFIG);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getServiceConfig()
      .then((config) => {
        if (!active) return;
        setSaved(config);
        setForm((current) => ({
          ...current,
          volcanoCredentialMode: config.volcanoCredentialMode,
          volcanoAppId: config.volcanoAppId,
          asrResourceId: config.asrResourceId,
          ttsCluster: config.ttsCluster,
          ttsVoiceType: config.ttsVoiceType,
        }));
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : '无法读取本地配置');
      });
    return () => {
      active = false;
    };
  }, []);

  const update = <Key extends keyof EditableConfig>(key: Key, value: EditableConfig[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const config = await apiRequest<ServiceConfig>('/api/config', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setSaved(config);
      onSaved(config);
      setForm((current) => ({
        ...current,
        deepseekApiKey: '',
        volcanoApiKey: '',
        volcanoAccessToken: '',
      }));
      setNotice('配置已使用 Windows 当前账户加密保存。');
      return config;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败');
      return null;
    } finally {
      setBusy('');
    }
  };

  const testDeepSeek = async () => {
    setBusy('deepseek');
    setError('');
    setNotice('');
    try {
      const result = await apiRequest<{ reply: string }>('/api/config/test/deepseek', {
        method: 'POST',
      });
      setNotice(`DeepSeek：${result.reply}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'DeepSeek 测试失败');
    } finally {
      setBusy('');
    }
  };

  const testSpeech = async () => {
    setBusy('speech');
    setError('');
    setNotice('');
    try {
      const result = await apiRequest<{ audioBase64: string }>('/api/config/test/speech', {
        method: 'POST',
      });
      const audio = new Audio(`data:audio/mp3;base64,${result.audioBase64}`);
      await audio.play();
      setNotice('火山语音合成连接成功，正在播放测试声音。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '语音测试失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="modal-backdrop settings-backdrop" role="presentation">
      <section aria-label="服务配置" aria-modal="true" className="modal service-modal" role="dialog">
        <button className="modal-close" onClick={onClose} type="button" aria-label="关闭">
          <X size={18} />
        </button>
        <div className="service-modal-heading">
          <span className="secure-icon">
            <ShieldCheck size={22} />
          </span>
          <div>
            <p className="eyebrow">LOCAL SECURE SETTINGS</p>
            <h2>连接她的听觉与声音</h2>
            <p className="modal-lede">密钥不会写进网页代码，只在这台电脑的 Windows 当前账户下加密保存。</p>
          </div>
        </div>

        <div className="service-status-row">
          <StatusPill label="DeepSeek" ready={saved.deepseekConfigured} />
          <StatusPill label="语音识别" ready={saved.volcanoAsrConfigured} />
          <StatusPill label="语音合成" ready={saved.volcanoTtsConfigured} />
        </div>

        <form className="service-form" onSubmit={save}>
          <section className="service-section">
            <div className="service-section-title">
              <KeyRound size={17} />
              <div>
                <strong>DeepSeek</strong>
                <small>使用 V4 Flash 非思考模式，优先降低回复延迟。</small>
              </div>
            </div>
            <label>
              <span>API Key {saved.deepseekConfigured ? '（已保存，留空表示不修改）' : ''}</span>
              <input
                autoComplete="off"
                onChange={(event) => update('deepseekApiKey', event.target.value)}
                placeholder="sk-..."
                type="password"
                value={form.deepseekApiKey}
              />
            </label>
          </section>

          <section className="service-section">
            <div className="service-section-title">
              <Volume2 size={17} />
              <div>
                <strong>火山引擎 · 语音识别</strong>
                <small>新版控制台使用 API Key；旧版控制台使用 App ID 与 Access Token。</small>
              </div>
            </div>
            <label>
              <span>控制台类型</span>
              <select
                onChange={(event) =>
                  update(
                    'volcanoCredentialMode',
                    event.target.value === 'legacy' ? 'legacy' : 'apiKey',
                  )
                }
                value={form.volcanoCredentialMode}
              >
                <option value="apiKey">新版控制台 · API Key</option>
                <option value="legacy">旧版控制台 · App ID / Access Token</option>
              </select>
            </label>
            {form.volcanoCredentialMode === 'apiKey' ? (
              <label>
                <span>火山 API Key {saved.volcanoAsrConfigured ? '（已保存可留空）' : ''}</span>
                <input
                  autoComplete="off"
                  onChange={(event) => update('volcanoApiKey', event.target.value)}
                  placeholder="从豆包语音控制台复制"
                  type="password"
                  value={form.volcanoApiKey}
                />
              </label>
            ) : null}
            <div className="field-row">
              <label>
                <span>App ID</span>
                <input
                  onChange={(event) => update('volcanoAppId', event.target.value)}
                  placeholder="控制台中的 APP ID"
                  value={form.volcanoAppId}
                />
              </label>
              <label>
                <span>Access Token {saved.volcanoAsrConfigured ? '（已保存可留空）' : ''}</span>
                <input
                  autoComplete="off"
                  onChange={(event) => update('volcanoAccessToken', event.target.value)}
                  placeholder="控制台中的 Access Token"
                  type="password"
                  value={form.volcanoAccessToken}
                />
              </label>
            </div>
            <label>
              <span>ASR Resource ID</span>
              <input
                onChange={(event) => update('asrResourceId', event.target.value)}
                value={form.asrResourceId}
              />
            </label>
          </section>

          <section className="service-section">
            <div className="service-section-title">
              <Volume2 size={17} />
              <div>
                <strong>火山引擎 · 预设女声</strong>
                <small>请从你已开通的音色列表复制 Voice Type；第一版使用完整音频缓冲播放。</small>
              </div>
            </div>
            <div className="field-row">
              <label>
                <span>Cluster</span>
                <input
                  onChange={(event) => update('ttsCluster', event.target.value)}
                  value={form.ttsCluster}
                />
              </label>
              <label>
                <span>Voice Type</span>
                <input
                  onChange={(event) => update('ttsVoiceType', event.target.value)}
                  placeholder="例如控制台音色 ID"
                  value={form.ttsVoiceType}
                />
              </label>
            </div>
          </section>

          {notice ? <p className="form-notice success">{notice}</p> : null}
          {error ? <p className="form-notice error">{error}</p> : null}

          <div className="service-actions">
            <button className="secondary-button" disabled={Boolean(busy)} onClick={testDeepSeek} type="button">
              {busy === 'deepseek' ? <LoaderCircle className="spin" size={15} /> : null}
              测试 DeepSeek
            </button>
            <button className="secondary-button" disabled={Boolean(busy)} onClick={testSpeech} type="button">
              {busy === 'speech' ? <LoaderCircle className="spin" size={15} /> : null}
              播放测试女声
            </button>
            <button className="primary-button service-save" disabled={Boolean(busy)} type="submit">
              {busy === 'save' ? <LoaderCircle className="spin" size={15} /> : null}
              保存配置
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
