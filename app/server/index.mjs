import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { protectSecret, unprotectSecret } from './secrets.mjs';

const APP_ROOT = resolve(import.meta.dirname, '..');
const PROJECT_ROOT = resolve(APP_ROOT, '..');
const DATA_DIR = join(APP_ROOT, 'data');
const CHARACTER_IMAGE_DIR = join(DATA_DIR, 'character-images');
const CONFIG_PATH = join(DATA_DIR, 'service-config.json');
const DIST_DIR = join(APP_ROOT, 'dist');
const SERVE_DIST = process.env.NIGHT_VOYAGE_SERVE_DIST === '1';
const PORT = Number(process.env.NIGHT_VOYAGE_PORT || 3001);
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const ANIMATION_SERVICE_URL = 'http://127.0.0.1:3011';
const ANIMATION_PYTHON = process.env.NIGHT_VOYAGE_ANIMATION_PYTHON || join(PROJECT_ROOT, 'runtime', 'envs', 'musetalk', 'python.exe');
const ANIMATION_SERVICE_DIR = join(PROJECT_ROOT, 'animation', 'service');
const ANIMATION_WORK_DIR = join(PROJECT_ROOT, 'animation', 'MuseTalk');
const ANIMATION_RENDER_DIR = process.env.NIGHT_VOYAGE_RENDER_DIR || join(PROJECT_ROOT, 'runtime', 'renders');
let animationProcess;
let animationStarting;

const DEFAULT_CONFIG = {
  volcanoCredentialMode: 'apiKey',
  asrResourceId: 'volc.bigasr.auc_turbo',
  ttsCluster: 'volcano_tts',
  ttsVoiceType: '',
};

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

await Promise.all([
  mkdir(DATA_DIR, { recursive: true }),
  mkdir(CHARACTER_IMAGE_DIR, { recursive: true }),
]);

async function readStoredConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeStoredConfig(config) {
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function loadSecrets(config) {
  const entries = await Promise.all([
    unprotectSecret(config.deepseekApiKeyCipher),
    unprotectSecret(config.volcanoApiKeyCipher),
    unprotectSecret(config.volcanoAccessTokenCipher),
  ]);
  return {
    deepseekApiKey: entries[0],
    volcanoApiKey: entries[1],
    volcanoAccessToken: entries[2],
  };
}

function publicConfig(config) {
  return {
    deepseekConfigured: Boolean(config.deepseekApiKeyCipher),
    volcanoAsrConfigured: Boolean(
      config.volcanoApiKeyCipher ||
        (config.volcanoAppId && config.volcanoAccessTokenCipher),
    ),
    volcanoTtsConfigured: Boolean(
      config.volcanoAppId && config.volcanoAccessTokenCipher && config.ttsVoiceType,
    ),
    volcanoCredentialMode: config.volcanoCredentialMode,
    volcanoAppId: config.volcanoAppId || '',
    asrResourceId: config.asrResourceId || DEFAULT_CONFIG.asrResourceId,
    ttsCluster: config.ttsCluster || DEFAULT_CONFIG.ttsCluster,
    ttsVoiceType: config.ttsVoiceType || '',
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      throw new Error('请求内容过大');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function animationHealth() {
  const response = await fetch(`${ANIMATION_SERVICE_URL}/health`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error('动画服务健康检查失败');
  return response.json();
}

async function ensureAnimationService() {
  try {
    return await animationHealth();
  } catch {
    // Start below.
  }
  if (!animationStarting) {
    animationStarting = (async () => {
      animationProcess = spawn(
        ANIMATION_PYTHON,
        [
          '-m',
          'uvicorn',
          'animation_service:app',
          '--app-dir',
          ANIMATION_SERVICE_DIR,
          '--host',
          '127.0.0.1',
          '--port',
          '3011',
        ],
        {
          cwd: ANIMATION_WORK_DIR,
          env: {
            ...process.env,
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
          },
          stdio: 'inherit',
          windowsHide: true,
        },
      );
      animationProcess.once('exit', () => {
        animationProcess = undefined;
      });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        try {
          return await animationHealth();
        } catch {
          // Keep waiting while Python imports its dependencies.
        }
      }
      throw new Error('本地动画服务启动超时');
    })().finally(() => {
      animationStarting = undefined;
    });
  }
  return animationStarting;
}

async function renderAnimation(body) {
  if (/^\/assets\/example-[ab]\.svg$/.test(String(body.avatar || ""))) {
    throw new Error("示例图片仅用于界面展示。请新建角色并上传自己的图片后再生成动画。");
  }
  if (!body.characterId || !body.avatar || !body.audioBase64) {
    throw new Error('角色图片或回复语音不完整');
  }
  let imageDataUrl = String(body.avatar);
  if (imageDataUrl.startsWith('/assets/')) {
    const assetName = imageDataUrl.slice('/assets/'.length);
    if (!/^[a-zA-Z0-9_.-]+$/.test(assetName)) {
      throw new Error('角色图片路径无效');
    }
    const assetPath = join(APP_ROOT, 'public', 'assets', assetName);
    const assetBytes = await readFile(assetPath);
    const mime = MIME_TYPES[extname(assetPath).toLowerCase()] || 'image/png';
    imageDataUrl = `data:${mime};base64,${assetBytes.toString('base64')}`;
  } else if (imageDataUrl.startsWith('/api/characters/image/')) {
    const imageName = imageDataUrl.slice('/api/characters/image/'.length);
    if (!/^[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(imageName)) {
      throw new Error('角色图片路径无效');
    }
    const imagePath = join(CHARACTER_IMAGE_DIR, imageName);
    const imageBytes = await readFile(imagePath);
    const mime = MIME_TYPES[extname(imagePath).toLowerCase()] || 'image/png';
    imageDataUrl = `data:${mime};base64,${imageBytes.toString('base64')}`;
  }
  await ensureAnimationService();
  const response = await fetch(`${ANIMATION_SERVICE_URL}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      character_id: String(body.characterId),
      image_data_url: imageDataUrl,
      audio_base64: String(body.audioBase64),
      reply_text: String(body.replyText || ''),
      emotion: String(body.behavior?.emotion || 'neutral'),
      intensity: Number(body.behavior?.intensity || 0.4),
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || '本地动画生成失败');
  }
  return {
    ...payload,
    videoUrl: `/api/animation/video/${encodeURIComponent(payload.file_name)}`,
  };
}

async function saveCharacterImage(body) {
  const characterId = String(body.characterId || '');
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(characterId)) {
    throw new Error('角色编号无效');
  }
  const match = /^data:image\/(png|jpe?g|webp);base64,([a-zA-Z0-9+/=\s]+)$/.exec(
    String(body.imageDataUrl || ''),
  );
  if (!match) throw new Error('请上传 JPG、PNG 或 WebP 图片');
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) {
    throw new Error('角色图片大小必须在 16MB 以内');
  }
  const fileName = `${characterId}.${extension}`;
  await writeFile(join(CHARACTER_IMAGE_DIR, fileName), bytes);
  return { ok: true, avatarUrl: `/api/characters/image/${fileName}` };
}

async function serveCharacterImage(response, pathname) {
  const fileName = decodeURIComponent(pathname.split('/').at(-1) || '');
  if (!/^[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(fileName)) {
    sendJson(response, 400, { error: '角色图片文件名无效' });
    return;
  }
  const filePath = join(CHARACTER_IMAGE_DIR, fileName);
  const content = await readFile(filePath);
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'image/png',
    'Content-Length': content.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  response.end(content);
}

async function deleteCharacterImage(response, pathname) {
  const fileName = decodeURIComponent(pathname.split('/').at(-1) || '');
  if (!/^[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(fileName)) {
    sendJson(response, 400, { error: '角色图片文件名无效' });
    return;
  }
  try {
    await unlink(join(CHARACTER_IMAGE_DIR, fileName));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  sendJson(response, 200, { ok: true });
}

async function serveAnimationVideo(request, response, pathname) {
  const fileName = decodeURIComponent(pathname.split('/').at(-1) || '');
  if (!/^[a-zA-Z0-9_-]+\.mp4$/.test(fileName)) {
    sendJson(response, 400, { error: '动画文件名无效' });
    return;
  }
  const filePath = join(ANIMATION_RENDER_DIR, fileName);
  const fileStat = await stat(filePath);
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${fileStat.size}` });
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), fileStat.size - 1) : fileStat.size - 1;
    if (start > end || start >= fileStat.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${fileStat.size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': fileStat.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath).pipe(response);
}

function cleanMessageList(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (message) =>
        message &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string',
    )
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 800),
    }));
}

const EMOTION_RULES = [
  ['happy', /开心|高兴|喜欢|想你|太好|真好|好呀|嘿嘿|嘻嘻|爱你|抱抱|期待|幸福/u],
  ['shy', /害羞|不好意思|脸红|秘密|亲亲|心跳|悄悄|不敢看/u],
  ['sad', /难过|伤心|失落|委屈|想哭|孤单|寂寞|不开心|舍不得/u],
  ['concerned', /担心|还好吗|没事吧|注意身体|休息|心疼|照顾好|别太累/u],
  ['angry', /生气|讨厌|不许|过分|气死|不能这样|太坏了/u],
  ['surprised', /居然|真的[吗？?]|天哪|哇|没想到|竟然|不会吧/u],
];

function inferReplyBehavior(reply) {
  const normalized = String(reply || '');
  let emotion = 'neutral';
  for (const [candidate, pattern] of EMOTION_RULES) {
    if (pattern.test(normalized)) {
      emotion = candidate;
      break;
    }
  }
  const emphasis =
    (normalized.match(/[！!]/g)?.length || 0) * 0.08 +
    (normalized.match(/[～~]/g)?.length || 0) * 0.04;
  const baseIntensity = emotion === 'neutral' ? 0.38 : 0.58;
  return {
    emotion,
    intensity: Math.min(0.88, Math.max(0.3, baseIntensity + emphasis)),
  };
}

function parseReplyWithBehavior(content) {
  const behaviorPattern =
    /\[\[\s*emotion\s*:\s*(happy|shy|sad|concerned|angry|surprised|neutral)\s*,\s*intensity\s*:\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\]\]\s*$/iu;
  const match = behaviorPattern.exec(content);
  const reply = (match ? content.slice(0, match.index) : content).trim();
  if (!reply) throw new Error('DeepSeek 没有返回有效内容');
  if (!match) return { reply, behavior: inferReplyBehavior(reply) };
  return {
    reply,
    behavior: {
      emotion: match[1].toLowerCase(),
      intensity: Math.min(0.9, Math.max(0.3, Number(match[2]))),
    },
  };
}

async function callDeepSeek({
  apiKey,
  characterName,
  personality,
  memories,
  history,
  text,
}) {
  if (!apiKey) throw new Error('尚未配置 DeepSeek API Key');
  const memoryText = Array.isArray(memories)
    ? memories
        .slice(0, 8)
        .map((memory) => memory?.text)
        .filter(Boolean)
        .join('；')
    : '';
  const systemPrompt = [
    `你叫${characterName || '小柒'}，正在和用户进行亲密、自然的日常陪伴对话。`,
    `你的人设：${personality || '温柔、细腻、有自己的观点。'}`,
    memoryText ? `你记得这些重要信息：${memoryText}` : '',
    '保持自己的性格和判断，不要一味附和，也不要自称AI、助手或模型。',
    '只使用自然口语中文回答。每次1到3句话，通常不超过100个汉字，适合直接朗读。',
    '根据回答内容判断你此刻最主要的情绪。回答正文结束后另起一行，严格附加形如[[emotion:happy,intensity:0.65]]的标签。',
    'emotion只能是happy、shy、sad、concerned、angry、surprised、neutral之一；intensity使用0.30到0.90之间的小数。不要解释标签。',
  ]
    .filter(Boolean)
    .join('\n');

  const apiResponse = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: systemPrompt },
        ...cleanMessageList(history),
        { role: 'user', content: String(text || '').slice(0, 1200) },
      ],
      max_tokens: 220,
      temperature: 0.85,
      stream: false,
    }),
  });

  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    throw new Error(payload?.error?.message || `DeepSeek 请求失败（${apiResponse.status}）`);
  }
  const content = payload?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('DeepSeek 没有返回有效内容');
  return parseReplyWithBehavior(content);
}

async function transcribeWithVolcano({ audioBase64, config, secrets }) {
  const hasNewCredential =
    config.volcanoCredentialMode !== 'legacy' && Boolean(secrets.volcanoApiKey);
  const hasLegacyCredential = Boolean(config.volcanoAppId && secrets.volcanoAccessToken);
  if (!hasNewCredential && !hasLegacyCredential) {
    throw new Error('尚未配置火山引擎语音识别凭证');
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': config.asrResourceId || DEFAULT_CONFIG.asrResourceId,
    'X-Api-Request-Id': randomUUID(),
    'X-Api-Sequence': '-1',
  };
  if (hasNewCredential) {
    headers['X-Api-Key'] = secrets.volcanoApiKey;
  } else {
    headers['X-Api-App-Key'] = config.volcanoAppId;
    headers['X-Api-Access-Key'] = secrets.volcanoAccessToken;
  }

  const apiResponse = await fetch(
    'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user: { uid: config.volcanoAppId || 'night-voyage' },
        audio: { data: audioBase64 },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
        },
      }),
    },
  );

  const payload = await apiResponse.json().catch(() => ({}));
  const statusCode = apiResponse.headers.get('X-Api-Status-Code');
  if (!apiResponse.ok || (statusCode && statusCode !== '20000000')) {
    const serviceMessage = apiResponse.headers.get('X-Api-Message');
    throw new Error(serviceMessage || `火山语音识别失败（${statusCode || apiResponse.status}）`);
  }
  const text = payload?.result?.text?.trim();
  if (!text) throw new Error('没有识别到有效语音，请靠近麦克风后重试');
  return text;
}

async function synthesizeWithVolcano({ text, config, secrets }) {
  if (!config.volcanoAppId || !secrets.volcanoAccessToken || !config.ttsVoiceType) {
    return { audioBase64: '', speechError: '火山语音合成参数尚未配置完整' };
  }

  const apiResponse = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer;${secrets.volcanoAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      app: {
        appid: config.volcanoAppId,
        token: secrets.volcanoAccessToken,
        cluster: config.ttsCluster || DEFAULT_CONFIG.ttsCluster,
      },
      user: { uid: 'night-voyage-local' },
      audio: {
        voice_type: config.ttsVoiceType,
        encoding: 'mp3',
        rate: 24000,
        speed_ratio: 1,
      },
      request: {
        reqid: randomUUID(),
        text,
        operation: 'query',
      },
    }),
  });

  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok || payload.code !== 3000 || !payload.data) {
    const message = payload.message || `火山语音合成失败（${apiResponse.status}）`;
    return { audioBase64: '', speechError: message };
  }
  return { audioBase64: payload.data, speechError: '' };
}

async function saveConfig(body) {
  const current = await readStoredConfig();
  const next = {
    ...current,
    volcanoCredentialMode:
      body.volcanoCredentialMode === 'legacy' ? 'legacy' : 'apiKey',
    volcanoAppId: String(body.volcanoAppId || '').trim(),
    asrResourceId:
      String(body.asrResourceId || '').trim() || DEFAULT_CONFIG.asrResourceId,
    ttsCluster: String(body.ttsCluster || '').trim() || DEFAULT_CONFIG.ttsCluster,
    ttsVoiceType: String(body.ttsVoiceType || '').trim(),
  };

  const secretUpdates = [
    ['deepseekApiKey', 'deepseekApiKeyCipher'],
    ['volcanoApiKey', 'volcanoApiKeyCipher'],
    ['volcanoAccessToken', 'volcanoAccessTokenCipher'],
  ];
  for (const [inputKey, storageKey] of secretUpdates) {
    if (typeof body[inputKey] === 'string' && body[inputKey].trim()) {
      next[storageKey] = await protectSecret(body[inputKey].trim());
    }
  }
  await writeStoredConfig(next);
  return publicConfig(next);
}

async function handleApi(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/api/health') {
    sendJson(response, 200, { ok: true, service: 'night-voyage-local' });
    return true;
  }
  if (request.method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, publicConfig(await readStoredConfig()));
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/config') {
    sendJson(response, 200, await saveConfig(await readJson(request)));
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/config/test/deepseek') {
    const config = await readStoredConfig();
    const secrets = await loadSecrets(config);
    const result = await callDeepSeek({
      apiKey: secrets.deepseekApiKey,
      characterName: '小柒',
      personality: '简洁、温柔',
      memories: [],
      history: [],
      text: '这是连接测试。请只回复“连接成功”。',
    });
    sendJson(response, 200, { ok: true, reply: result.reply });
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/config/test/speech') {
    const config = await readStoredConfig();
    const secrets = await loadSecrets(config);
    const result = await synthesizeWithVolcano({
      text: '你好，语音服务连接成功。',
      config,
      secrets,
    });
    if (!result.audioBase64) throw new Error(result.speechError);
    sendJson(response, 200, { ok: true, ...result });
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/chat') {
    const body = await readJson(request);
    const config = await readStoredConfig();
    const secrets = await loadSecrets(config);
    const result = await callDeepSeek({
      apiKey: secrets.deepseekApiKey,
      characterName: body.characterName,
      personality: body.personality,
      memories: body.memories,
      history: body.history,
      text: body.text,
    });
    const speech = await synthesizeWithVolcano({ text: result.reply, config, secrets });
    sendJson(response, 200, {
      ok: true,
      text: body.text,
      reply: result.reply,
      behavior: result.behavior,
      ...speech,
    });
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/voice-turn') {
    const body = await readJson(request);
    if (!body.audioBase64) throw new Error('没有收到录音内容');
    const config = await readStoredConfig();
    const secrets = await loadSecrets(config);
    const text = await transcribeWithVolcano({
      audioBase64: body.audioBase64,
      config,
      secrets,
    });
    const result = await callDeepSeek({
      apiKey: secrets.deepseekApiKey,
      characterName: body.characterName,
      personality: body.personality,
      memories: body.memories,
      history: body.history,
      text,
    });
    const speech = await synthesizeWithVolcano({ text: result.reply, config, secrets });
    sendJson(response, 200, {
      ok: true,
      text,
      reply: result.reply,
      behavior: result.behavior,
      ...speech,
    });
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/characters/image') {
    sendJson(response, 200, await saveCharacterImage(await readJson(request)));
    return true;
  }
  if (request.method === 'GET' && pathname.startsWith('/api/characters/image/')) {
    await serveCharacterImage(response, pathname);
    return true;
  }
  if (request.method === 'DELETE' && pathname.startsWith('/api/characters/image/')) {
    await deleteCharacterImage(response, pathname);
    return true;
  }
  if (request.method === 'GET' && pathname === '/api/animation/health') {
    const health = await ensureAnimationService();
    sendJson(response, 200, health);
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/animation/render') {
    sendJson(response, 200, await renderAnimation(await readJson(request)));
    return true;
  }
  if (request.method === 'GET' && pathname.startsWith('/api/animation/video/')) {
    await serveAnimationVideo(request, response, pathname);
    return true;
  }
  return false;
}

async function serveStatic(response, pathname) {
  let relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  relativePath = normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST_DIR, relativePath);
  if (!filePath.startsWith(DIST_DIR)) {
    sendJson(response, 403, { error: '无权访问该路径' });
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    });
    response.end(content);
  } catch {
    filePath = join(DIST_DIR, 'index.html');
    try {
      const content = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(content);
    } catch {
      sendJson(response, 503, { error: '尚未构建网页，请先运行 pnpm run build' });
    }
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || HOST}`);
  try {
    const handled = await handleApi(request, response, url.pathname);
    if (handled) return;
    if (SERVE_DIST && request.method === 'GET') {
      await serveStatic(response, url.pathname);
      return;
    }
    sendJson(response, 404, { error: '接口不存在' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '本地服务发生未知错误';
    sendJson(response, 400, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`夜航本地服务已启动：http://${HOST}:${PORT}`);
});

function stopAnimationService() {
  if (animationProcess && !animationProcess.killed) {
    animationProcess.kill();
  }
}

process.on('exit', stopAnimationService);
process.on('SIGINT', () => {
  stopAnimationService();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAnimationService();
  process.exit(0);
});
