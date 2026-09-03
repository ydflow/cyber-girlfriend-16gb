import {
  BookHeart,
  CircleAlert,
  CirclePlus,
  Heart,
  MessageCircleMore,
  Mic,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  UsersRound,
  Volume2,
  X,
} from 'lucide-react';
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { apiRequest, EMPTY_SERVICE_CONFIG, getServiceConfig, ServiceConfig } from './api';
import { recordingBlobToWavBase64 } from './audio';
import ServiceSettingsModal from './ServiceSettingsModal';

type Section = 'chat' | 'characters' | 'memories';
type VoiceState = 'ready' | 'listening' | 'thinking' | 'rendering' | 'speaking';

type Memory = {
  id: string;
  text: string;
  date: string;
};

type Character = {
  id: string;
  name: string;
  avatar: string;
  personality: string;
  voice: string;
  greeting: string;
  memories: Memory[];
};

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

type ReplyBehavior = {
  emotion: 'happy' | 'shy' | 'sad' | 'concerned' | 'angry' | 'surprised' | 'neutral';
  intensity: number;
};

const EXAMPLE_A_CHARACTER: Character = {
  "id": "example-a",
  "name": "示例角色 A",
  "avatar": "/assets/example-a.svg",
  "personality": "温和、耐心，回复自然简洁。",
  "voice": "default",
  "greeting": "你好，我是示例角色 A。添加自己的角色后就可以开始体验。",
  "memories": []
};

const EXAMPLE_B_CHARACTER: Character = {
  "id": "example-b",
  "name": "示例角色 B",
  "avatar": "/assets/example-b.svg",
  "personality": "开朗、友好，善于倾听并给出积极回应。",
  "voice": "default",
  "greeting": "你好，我是示例角色 B。请先配置服务，再开始语音对话。",
  "memories": []
};

const BUILT_IN_CHARACTERS = [EXAMPLE_A_CHARACTER, EXAMPLE_B_CHARACTER];
const PROTECTED_CHARACTER_IDS = new Set(BUILT_IN_CHARACTERS.map((character) => character.id));

const VOICE_LABEL: Record<VoiceState, { title: string; hint: string }> = {
  ready: { title: '点击和我说话', hint: '麦克风只在你点击后启用' },
  listening: { title: '正在听你说', hint: '停顿约 1 秒后自动发送' },
  thinking: { title: '她正在想', hint: '正在识别并组织自然回答' },
  rendering: { title: '正在生成真人动画', hint: '分析情绪、高清口型与自然动作' },
  speaking: { title: '正在回应', hint: '点击可以停止播放' },
};

const WAVEFORM_BARS = [
  4, 7, 5, 10, 14, 8, 18, 11, 24, 15, 30, 12, 20, 9, 26, 14, 32, 18, 10, 22, 12, 28, 16, 8,
  20, 12, 26, 14, 7, 18, 11, 23, 9, 16, 6, 12, 5, 9,
];

function loadCharacters(): Character[] {
  try {
    const raw = localStorage.getItem("public-companion.characters.v1");
    const saved = raw ? (JSON.parse(raw) as Character[]) : [];
    const userCharacters = saved.filter(
      (character) => !PROTECTED_CHARACTER_IDS.has(character.id),
    );
    return [...BUILT_IN_CHARACTERS, ...userCharacters];
  } catch {
    return BUILT_IN_CHARACTERS;
  }
}

function loadChatHistory(): Record<string, ChatMessage[]> {
  try {
    const raw = localStorage.getItem("public-companion.chat-history.v1");
    return raw ? (JSON.parse(raw) as Record<string, ChatMessage[]>) : {};
  } catch {
    return {};
  }
}

function NavButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={`nav-button ${active ? 'is-active' : ''}`} onClick={onClick} type="button">
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ChatPanel({
  character,
  voiceState,
  lastUserText,
  lastAssistantText,
  voiceError,
}: {
  character: Character;
  voiceState: VoiceState;
  lastUserText: string;
  lastAssistantText: string;
  voiceError: string;
}) {
  return (
    <section className="content-panel chat-panel" aria-label="对话">
      <div className="conversation-copy">
        <h1>
          欢迎回来，
          <br />
          今天也很想你
          <Heart aria-hidden="true" className="heading-heart" fill="currentColor" size={22} />
        </h1>
        <p className="companion-line">
          {voiceState === 'thinking'
            ? `${character.name}正在认真理解你刚才说的话。`
            : voiceState === 'rendering'
              ? `${character.name}正在把回答变成自然的表情和口型。`
            : voiceState === 'listening'
              ? `${character.name}正在安静地听你说。`
              : `${character.name}正在等你说说今天的故事。`}
        </p>
        <div className="recent-conversation">
          <p className="recent-title">最近的对话</p>
          <div className="last-exchange">
            <p aria-label={`你说：${lastUserText || '今天过得怎么样？'}`}>
              <span className="exchange-icon">
                <MessageCircleMore size={15} />
              </span>
              <span className="exchange-copy">{lastUserText || '今天过得怎么样？'}</span>
              <time>20:41</time>
            </p>
            <p aria-label={`${character.name}说：${lastAssistantText || '还不错，就是有点想你。'}`}>
              <span className="exchange-icon">
                <Volume2 size={15} />
              </span>
              <span className="exchange-copy">
                {lastAssistantText || '还不错，就是有点想你。'}
              </span>
              <time>20:41</time>
            </p>
          </div>
        </div>
        {voiceError ? (
          <p className="voice-error">
            <CircleAlert size={13} />
            {voiceError}
          </p>
        ) : null}
      </div>

    </section>
  );
}

function CharacterPanel({
  characters,
  activeId,
  onChoose,
  onAdd,
  onRequestDelete,
}: {
  characters: Character[];
  activeId: string;
  onChoose: (id: string) => void;
  onAdd: () => void;
  onRequestDelete: (character: Character) => void;
}) {
  return (
    <section className="content-panel list-panel">
      <div className="section-heading">
        <div>
          <h1>我的角色</h1>
          <p className="section-lede">每个角色都有独立的人设、声音和记忆。</p>
        </div>
        <button className="text-button" onClick={onAdd} type="button">
          <CirclePlus size={17} />
          新建角色
        </button>
      </div>
      <div className="character-list">
        {characters.map((character) => {
          const isProtected = PROTECTED_CHARACTER_IDS.has(character.id);
          return (
            <article
              className={`character-row ${character.id === activeId ? 'is-active' : ''}`}
              key={character.id}
            >
              <button
                className="character-select"
                onClick={() => onChoose(character.id)}
                type="button"
              >
                <span className="character-radio" aria-hidden="true" />
                <img src={character.avatar} alt="" />
                <span className="character-row-copy">
                  <span className="character-name-line">
                    <strong>{character.name}</strong>
                    {isProtected ? <small className="built-in-label">内置</small> : null}
                  </span>
                  <small>{character.personality}</small>
                  <span className="voice-label">
                    <Volume2 size={13} />
                    {character.voice}
                  </span>
                </span>
              </button>
              {isProtected ? (
                <span className="protected-label">
                  <ShieldCheck size={16} />
                  受保护的角色
                </span>
              ) : (
                <button
                  aria-label={`删除${character.name}`}
                  className="delete-character-button"
                  onClick={() => onRequestDelete(character)}
                  title={`删除${character.name}`}
                  type="button"
                >
                  <Trash2 size={18} />
                </button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function MemoryPanel({ character }: { character: Character }) {
  return (
    <section className="content-panel list-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">SHARED MEMORIES</p>
          <h1>她记得的事</h1>
        </div>
        <span className="memory-count">{character.memories.length} 条</span>
      </div>
      <p className="section-lede">只保存在这台电脑。未来接入模型后，她会在合适的时候自然地想起这些片段。</p>
      <div className="memory-list">
        {character.memories.map((memory, index) => (
          <article className="memory-item" key={memory.id}>
            <span className="memory-index">0{index + 1}</span>
            <div>
              <p>{memory.text}</p>
              <small>{memory.date}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function NewCharacterModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (character: Character) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [personality, setPersonality] = useState('');
  const [voice, setVoice] = useState('');
  const [preview, setPreview] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const handleImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener('load', () => setPreview(String(reader.result)));
    reader.readAsDataURL(file);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !preview) return;
    setSaving(true);
    setSaveError('');
    try {
      await onCreate({
        id: crypto.randomUUID(),
        name: name.trim(),
        avatar: preview,
        personality: personality.trim() || '温柔而独立，愿意认真听你说话。',
        voice,
        greeting: `“你来啦，我是${name.trim()}。”`,
        memories: [{ id: crypto.randomUUID(), text: '这是你们第一次见面。', date: '今天' }],
      });
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : '角色图片保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="新建角色"
        aria-modal="true"
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <button className="modal-close" onClick={onClose} type="button" aria-label="关闭">
          <X size={18} />
        </button>
        <p className="eyebrow">NEW COMPANION</p>
        <h2>创造一个新角色</h2>
        <p className="modal-lede">上传你指定的人物图片，为她设置名字、人设与预设声音。</p>
        <form onSubmit={submit}>
          <label className={`image-upload ${preview ? 'has-image' : ''}`}>
            {preview ? (
              <img src={preview} alt="角色预览" />
            ) : (
              <>
                <UserRound size={26} />
                <strong>选择人物图片</strong>
                <span>支持 JPG、PNG、WEBP</span>
              </>
            )}
            <input accept="image/*" onChange={handleImage} type="file" />
          </label>
          <div className="field-row">
            <label>
              <span>名字</span>
              <input
                maxLength={12}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：示例角色 A"
                value={name}
              />
            </label>
            <label>
              <span>声音</span>
              <select onChange={(event) => setVoice(event.target.value)} value={voice}>
                <option></option>
                <option>清澈女声 · 02</option>
                <option>知性女声 · 03</option>
              </select>
            </label>
          </div>
          <label>
            <span>性格与相处方式</span>
            <textarea
              maxLength={180}
              onChange={(event) => setPersonality(event.target.value)}
              placeholder="她是什么性格？希望她怎么与你相处？"
              rows={3}
              value={personality}
            />
          </label>
          {saveError ? <p className="form-error">{saveError}</p> : null}
          <button className="primary-button" disabled={!name.trim() || !preview || saving} type="submit">
            {saving ? '正在保存…' : '创建角色'}
          </button>
        </form>
      </section>
    </div>
  );
}

function DeleteCharacterModal({
  character,
  onClose,
  onConfirm,
}: {
  character: Character;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop delete-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label={`删除${character.name}`}
        aria-modal="true"
        className="delete-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <button className="modal-close" onClick={onClose} type="button" aria-label="关闭">
          <X size={18} />
        </button>
        <span className="delete-modal-icon">
          <Trash2 size={22} />
        </span>
        <h2>删除{character.name}？</h2>
        <p>删除后，她的角色资料和本地对话记录将无法恢复。</p>
        <div className="delete-modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            取消
          </button>
          <button className="danger-button" onClick={onConfirm} type="button">
            确认删除
          </button>
        </div>
      </section>
    </div>
  );
}

function App() {
  const [section, setSection] = useState<Section>('chat');
  const [characters, setCharacters] = useState<Character[]>(loadCharacters);
  const [activeId, setActiveId] = useState('example-b');
  const [voiceState, setVoiceState] = useState<VoiceState>('ready');
  const [showModal, setShowModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Character | null>(null);
  const [serviceConfig, setServiceConfig] = useState<ServiceConfig>(EMPTY_SERVICE_CONFIG);
  const [chatHistory, setChatHistory] = useState<Record<string, ChatMessage[]>>(loadChatHistory);
  const [voiceError, setVoiceError] = useState('');
  const [animationVideoUrl, setAnimationVideoUrl] = useState('');
  const [animationIsEnding, setAnimationIsEnding] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const monitorFrameRef = useRef<number | null>(null);
  const playbackRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeCharacter =
    characters.find((character) => character.id === activeId) ?? characters[0] ?? EXAMPLE_B_CHARACTER;
  const activeHistory = chatHistory[activeId] ?? [];
  const lastUserText =
    [...activeHistory].reverse().find((message) => message.role === 'user')?.content ?? '';
  const lastAssistantText =
    [...activeHistory].reverse().find((message) => message.role === 'assistant')?.content ?? '';
  const servicesReady =
    serviceConfig.deepseekConfigured &&
    serviceConfig.volcanoAsrConfigured &&
    serviceConfig.volcanoTtsConfigured;

  useEffect(() => {
    try {
      localStorage.setItem("public-companion.characters.v1", JSON.stringify(characters));
    } catch {
      // Large uploaded previews can exceed localStorage; the current session still works.
    }
  }, [characters]);

  useEffect(() => {
    try {
      localStorage.setItem("public-companion.chat-history.v1", JSON.stringify(chatHistory));
    } catch {
      // Keep the current conversation available for this session.
    }
  }, [chatHistory]);

  useEffect(() => {
    getServiceConfig().then(setServiceConfig).catch(() => setServiceConfig(EMPTY_SERVICE_CONFIG));
  }, []);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      playbackRef.current?.pause();
      videoRef.current?.pause();
      if (monitorFrameRef.current !== null) cancelAnimationFrame(monitorFrameRef.current);
      void audioContextRef.current?.close();
    },
    [],
  );

  const finishListening = () => {
    if (monitorFrameRef.current !== null) {
      cancelAnimationFrame(monitorFrameRef.current);
      monitorFrameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  const playReply = async (audioBase64: string) => {
    if (!audioBase64) {
      setVoiceState('ready');
      return;
    }
    playbackRef.current?.pause();
    const audio = new Audio(`data:audio/mp3;base64,${audioBase64}`);
    playbackRef.current = audio;
    audio.addEventListener('ended', () => setVoiceState('ready'), { once: true });
    setVoiceState('speaking');
    try {
      await audio.play();
    } catch {
      setVoiceError('回复文字已生成，但浏览器未能自动播放声音。');
      setVoiceState('ready');
    }
  };

  const playAnimatedReply = async (
    audioBase64: string,
    character: Character,
    replyText: string,
    behavior: ReplyBehavior,
  ) => {
    if (!audioBase64) {
      setVoiceState('ready');
      return;
    }
    setVoiceState('rendering');
    try {
      const animation = await apiRequest<{ videoUrl: string; initialized_now: boolean }>(
        '/api/animation/render',
        {
          method: 'POST',
          body: JSON.stringify({
            characterId: character.id,
            avatar: character.avatar,
            audioBase64,
            replyText,
            behavior,
          }),
        },
      );
      setAnimationIsEnding(false);
      setAnimationVideoUrl(`${animation.videoUrl}?t=${Date.now()}`);
      setVoiceState('speaking');
    } catch (caught) {
      setVoiceError(
        `动画暂时生成失败，已改为语音播放：${
          caught instanceof Error ? caught.message : '未知错误'
        }`,
      );
      await playReply(audioBase64);
    }
  };

  const processRecording = async (blob: Blob) => {
    if (blob.size < 900) {
      setVoiceError('录音时间太短，请重新说一次。');
      setVoiceState('ready');
      return;
    }
    setVoiceState('thinking');
    try {
      const audioBase64 = await recordingBlobToWavBase64(blob);
      const result = await apiRequest<{
        text: string;
        reply: string;
        audioBase64: string;
        behavior: ReplyBehavior;
        speechError?: string;
      }>('/api/voice-turn', {
        method: 'POST',
        body: JSON.stringify({
          audioBase64,
          characterName: activeCharacter.name,
          personality: activeCharacter.personality,
          memories: activeCharacter.memories,
          history: activeHistory.map(({ role, content }) => ({ role, content })),
        }),
      });
      const timestamp = new Date().toISOString();
      setChatHistory((current) => ({
        ...current,
        [activeCharacter.id]: [
          ...(current[activeCharacter.id] ?? []),
          { role: 'user' as const, content: result.text, createdAt: timestamp },
          { role: 'assistant' as const, content: result.reply, createdAt: timestamp },
        ].slice(-40),
      }));
      if (result.speechError) setVoiceError(`文字回复成功；语音合成提示：${result.speechError}`);
      await playAnimatedReply(
        result.audioBase64,
        activeCharacter,
        result.reply,
        result.behavior ?? { emotion: 'neutral', intensity: 0.4 },
      );
    } catch (caught) {
      setVoiceError(caught instanceof Error ? caught.message : '本次语音对话失败');
      setVoiceState('ready');
    }
  };

  const startListening = async () => {
    if (!servicesReady) {
      setVoiceError('请先完成 DeepSeek、语音识别和语音合成配置。');
      setShowSettings(true);
      return;
    }
    setVoiceError('');
    setAnimationVideoUrl('');
    setAnimationIsEnding(false);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    streamRef.current = stream;
    recordingChunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) recordingChunksRef.current.push(event.data);
    });
    recorder.addEventListener(
      'stop',
      () => {
        const recordedBlob = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        void processRecording(recordedBlob);
      },
      { once: true },
    );
    recorder.start(200);
    setVoiceState('listening');

    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();
    let speechStarted = false;
    let lastSoundAt = startedAt;

    const monitorSilence = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const level = Math.sqrt(sum / samples.length);
      const now = performance.now();
      if (level > 0.025) {
        speechStarted = true;
        lastSoundAt = now;
      }
      if ((speechStarted && now - lastSoundAt > 1100) || now - startedAt > 20000) {
        finishListening();
        return;
      }
      monitorFrameRef.current = requestAnimationFrame(monitorSilence);
    };
    monitorFrameRef.current = requestAnimationFrame(monitorSilence);
  };

  const handleVoice = async () => {
    if (voiceState === 'listening') {
      finishListening();
      return;
    }
    if (voiceState === 'speaking') {
      playbackRef.current?.pause();
      videoRef.current?.pause();
      setAnimationVideoUrl('');
      setVoiceState('ready');
      return;
    }
    if (voiceState !== 'ready') return;

    try {
      await startListening();
    } catch (caught) {
      setVoiceError(
        caught instanceof Error && caught.name === 'NotAllowedError'
          ? '需要允许浏览器使用麦克风，才能听到你说话。'
          : caught instanceof Error
            ? caught.message
            : '无法启动麦克风',
      );
      setVoiceState('ready');
    }
  };

  const chooseCharacter = (id: string) => {
    setActiveId(id);
    setSection('chat');
    setAnimationVideoUrl('');
    setVoiceState('ready');
  };

  const createCharacter = async (character: Character) => {
    const uploaded = await apiRequest<{ avatarUrl: string }>('/api/characters/image', {
      method: 'POST',
      body: JSON.stringify({
        characterId: character.id,
        imageDataUrl: character.avatar,
      }),
    });
    const storedCharacter = { ...character, avatar: uploaded.avatarUrl };
    setCharacters((current) => [...current, storedCharacter]);
    setActiveId(storedCharacter.id);
    setShowModal(false);
    setSection('chat');
  };

  const deleteCharacter = async () => {
    if (!pendingDelete || PROTECTED_CHARACTER_IDS.has(pendingDelete.id)) return;
    const character = pendingDelete;
    setPendingDelete(null);
    setCharacters((current) => current.filter((item) => item.id !== character.id));
    setChatHistory((current) => {
      const next = { ...current };
      delete next[character.id];
      return next;
    });
    if (activeId === character.id) {
      setActiveId(EXAMPLE_B_CHARACTER.id);
      setSection('chat');
      setAnimationVideoUrl('');
      setVoiceState('ready');
    }
    if (character.avatar.startsWith('/api/characters/image/')) {
      try {
        await apiRequest<{ ok: boolean }>(character.avatar, { method: 'DELETE' });
      } catch {
        // The role is removed locally even if an old image file cannot be cleaned up.
      }
    }
  };

  return (
    <main className="app-shell">
      <aside className="side-nav">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Heart size={26} fill="currentColor" />
            <Sparkles size={12} />
          </span>
          <span>夜航</span>
        </div>
        <nav>
          <NavButton
            active={section === 'chat'}
            icon={<MessageCircleMore size={18} />}
            label="对话"
            onClick={() => setSection('chat')}
          />
          <NavButton
            active={section === 'characters'}
            icon={<UsersRound size={18} />}
            label="角色"
            onClick={() => setSection('characters')}
          />
          <NavButton
            active={section === 'memories'}
            icon={<BookHeart size={18} />}
            label="记忆"
            onClick={() => setSection('memories')}
          />
        </nav>
        <div className="companion-switcher" aria-label="快速切换角色">
          {characters.slice(0, 4).map((character) => (
            <button
              aria-label={`切换到${character.name}`}
              className={character.id === activeId ? 'is-active' : ''}
              key={character.id}
              onClick={() => chooseCharacter(character.id)}
              type="button"
            >
              <img src={character.avatar} alt="" />
              <span />
            </button>
          ))}
        </div>
        <button aria-label="服务配置" className="settings-button" onClick={() => setShowSettings(true)} type="button">
          <Settings2 size={18} />
        </button>
      </aside>

      <section className="workspace">
        <header className={`top-bar ${section === 'chat' ? 'is-blended' : 'is-light'}`}>
          <div className="active-person">
            <span className="avatar-thumb">
              <img src={activeCharacter.avatar} alt="" />
            </span>
            <span>
              <strong>{activeCharacter.name}</strong>
              <small>
                <i className={`live-dot ${voiceState}`} />
                {voiceState === 'ready'
                  ? '陪伴中'
                  : voiceState === 'listening'
                    ? '正在聆听'
                    : voiceState === 'thinking'
                      ? '正在思考'
                      : voiceState === 'rendering'
                        ? '正在生成动画'
                      : '正在说话'}
              </small>
            </span>
          </div>
          <div className="top-actions">
            <button className="new-character" onClick={() => setShowModal(true)} type="button">
              <CirclePlus size={17} />
              新建角色
            </button>
            <button
              aria-label={servicesReady ? '服务已连接，打开服务配置' : '配置服务'}
              className={`service-status-button ${servicesReady ? 'is-ready' : ''}`}
              onClick={() => setShowSettings(true)}
              title={servicesReady ? '服务已连接' : '配置服务'}
              type="button"
            >
              <Settings2 size={20} />
              <i />
            </button>
          </div>
        </header>

        <div className={`stage stage-${section}`}>
          <div className="left-stage">
            {section === 'chat' ? (
              <ChatPanel
                character={activeCharacter}
                lastAssistantText={lastAssistantText}
                lastUserText={lastUserText}
                voiceError={voiceError}
                voiceState={voiceState}
              />
            ) : null}
            {section === 'characters' ? (
              <CharacterPanel
                activeId={activeId}
                characters={characters}
                onAdd={() => setShowModal(true)}
                onChoose={chooseCharacter}
                onRequestDelete={setPendingDelete}
              />
            ) : null}
            {section === 'memories' ? <MemoryPanel character={activeCharacter} /> : null}
          </div>

          {section === 'chat' ? (
            <div className="portrait-stage">
              <img src={activeCharacter.avatar} alt={`${activeCharacter.name}的人物形象`} />
              {animationVideoUrl ? (
                <video
                  autoPlay
                  className={animationIsEnding ? 'is-ending' : ''}
                  onEnded={() => {
                    setAnimationIsEnding(false);
                    setAnimationVideoUrl('');
                    setVoiceState('ready');
                  }}
                  onError={() => {
                    setVoiceError('动画视频播放失败，请再试一次。');
                    setAnimationIsEnding(false);
                    setAnimationVideoUrl('');
                    setVoiceState('ready');
                  }}
                  onTimeUpdate={(event) => {
                    const video = event.currentTarget;
                    if (
                      Number.isFinite(video.duration) &&
                      video.duration - video.currentTime < 0.28
                    ) {
                      setAnimationIsEnding(true);
                    }
                  }}
                  playsInline
                  ref={videoRef}
                  src={animationVideoUrl}
                />
              ) : null}
              <span className="portrait-vignette" />
              <span className="portrait-grain" />
            </div>
          ) : null}

          {section === 'chat' ? (
            <button
              aria-label={VOICE_LABEL[voiceState].title}
              className={`voice-control state-${voiceState}`}
              onClick={handleVoice}
              type="button"
            >
              <span className="voice-icon">
                {voiceState === 'speaking' ? <Volume2 size={19} /> : <Mic size={19} />}
              </span>
              <span>
                <strong>{VOICE_LABEL[voiceState].title}</strong>
                <small>{VOICE_LABEL[voiceState].hint}</small>
              </span>
            </button>
          ) : null}

          {section === 'chat' ? (
            <div className="subtitle-bar">
              <Heart size={20} fill="currentColor" />
              <span className="subtitle-divider" aria-hidden="true" />
              <p>{lastAssistantText ? `“${lastAssistantText}”` : activeCharacter.greeting}</p>
              <span className="subtitle-wave" aria-hidden="true">
                {WAVEFORM_BARS.map((height, index) => (
                  <i key={`${height}-${index}`} style={{ height }} />
                ))}
              </span>
            </div>
          ) : null}
        </div>
      </section>

      {showSettings ? (
        <ServiceSettingsModal
          onClose={() => setShowSettings(false)}
          onSaved={setServiceConfig}
        />
      ) : null}

      {showModal ? <NewCharacterModal onClose={() => setShowModal(false)} onCreate={createCharacter} /> : null}
      {pendingDelete ? (
        <DeleteCharacterModal
          character={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => void deleteCharacter()}
        />
      ) : null}
    </main>
  );
}

export default App;
