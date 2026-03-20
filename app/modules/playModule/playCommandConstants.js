import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';

export const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PLAY_TIMEOUT_MS || '900000', 10);
export const DOWNLOAD_TIMEOUT_MS = Number.parseInt(process.env.PLAY_DOWNLOAD_TIMEOUT_MS || '1800000', 10);
export const MEDIA_INFO_TIMEOUT_MS = Number.parseInt(process.env.PLAY_MEDIA_INFO_TIMEOUT_MS || '120000', 10);
export const PLAY_YTMP3_ENABLED = String(process.env.PLAY_YTMP3_ENABLED || 'true').toLowerCase() !== 'false';
export const PLAY_YTMP3_API_BASE_URL = (process.env.PLAY_YTMP3_API_BASE_URL || 'https://hub.ytconvert.org').trim();
export const PLAY_YTMP3_API_DOWNLOAD_PATH = (process.env.PLAY_YTMP3_API_DOWNLOAD_PATH || '/api/download').trim() || '/api/download';
export const PLAY_YTMP3_POLL_INTERVAL_MS = Math.max(500, Number.parseInt(process.env.PLAY_YTMP3_POLL_INTERVAL_MS || '2000', 10) || 2000);
export const PLAY_YTMP3_SEARCH_BASE_URL = (process.env.PLAY_YTMP3_SEARCH_BASE_URL || 'https://yt-meta.ytconvert.org').trim();
export const PLAY_YTMP3_SEARCH_PATH = (process.env.PLAY_YTMP3_SEARCH_PATH || '/search').trim() || '/search';
export const PLAY_YTMP3_VIDEO_DEFAULT_QUALITY = (process.env.PLAY_YTMP3_VIDEO_DEFAULT_QUALITY || '720').trim();

const PLAY_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLAY_LOCAL_DIR = path.join(PLAY_MODULE_DIR, 'local');
export const PLAY_DOWNLOADS_DIR = path.join(PLAY_LOCAL_DIR, 'downloads');
export const MAX_SEARCH_RESULTS = Math.min(10, Math.max(1, Number.parseInt(process.env.PLAY_SEARCH_RESULTS || '5', 10)));

const MAX_MEDIA_MB = Number.parseInt(process.env.PLAY_MAX_MB || '100', 10);
export const MAX_MEDIA_BYTES = Number.isFinite(MAX_MEDIA_MB) ? MAX_MEDIA_MB * 1024 * 1024 : 100 * 1024 * 1024;
export const MAX_MEDIA_MB_LABEL = Number.isFinite(MAX_MEDIA_MB) ? MAX_MEDIA_MB : 100;

export const THUMBNAIL_TIMEOUT_MS = 15000;
export const MAX_THUMB_BYTES = 5 * 1024 * 1024;
export const VIDEO_PROCESS_TIMEOUT_MS = Number.parseInt(process.env.PLAY_VIDEO_PROCESS_TIMEOUT_MS || '420000', 10);
export const VIDEO_FORCE_TRANSCODE = String(process.env.PLAY_VIDEO_FORCE_TRANSCODE || 'true').toLowerCase() !== 'false';
export const FFMPEG_BIN = (process.env.FFMPEG_PATH || 'ffmpeg').trim();
export const FFPROBE_BIN = (process.env.FFPROBE_PATH || 'ffprobe').trim();

export const SEARCH_CACHE_TTL_MS = 60 * 1000;
export const MAX_SEARCH_CACHE_ENTRIES = 500;
export const MAX_REDIRECTS = 2;
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const MAX_META_BODY_CHARS = 512;

export const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);
export const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);

export const YTDLS_ENDPOINTS = {
  search: 'local:search',
  queueStatus: 'local:queue-status',
  download: 'local:download',
  thumbnail: 'thumbnail',
  ytmp3Create: 'ytmp3:create',
  ytmp3Poll: 'ytmp3:poll',
  ytmp3Download: 'ytmp3:download',
  ytmp3Search: 'ytmp3:search',
  ytmp3Metadata: 'ytmp3:metadata',
};

export const ERROR_CODES = {
  INVALID_INPUT: 'EINVALID_INPUT',
  API: 'EAPI',
  TIMEOUT: 'ETIMEOUT',
  TOO_BIG: 'ETOOBIG',
  NOT_FOUND: 'ENOTFOUND',
};

export const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODES));

export const TYPE_CONFIG = {
  audio: {
    waitText: '⏳ Processando sua mídia...',
    queueWaitText: '⏳ Processando...',
    readyTitle: '🎵 Áudio pronto!',
    mimeFallback: 'audio/mpeg',
  },
  video: {
    waitText: '⏳ Processando sua mídia...',
    queueWaitText: '⏳ Processando...',
    readyTitle: '🎬 Vídeo pronto!',
    mimeFallback: 'video/mp4',
  },
};

export const FILE_ACCESS_MODE = os.platform() === 'win32' ? 'F_OK' : 'X_OK';
