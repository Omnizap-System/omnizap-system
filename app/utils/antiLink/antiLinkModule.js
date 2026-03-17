import { URL } from 'node:url';
import { isUserAdmin, updateGroupParticipants } from '../../config/index.js';
import { getJidUser, isGroupJid, isLidJid, isSameJidUser, isSocketOpen, isWhatsAppJid, normalizeJid, parseEnvInt, runActiveSocketMethod, getActiveSocket } from '../../config/index.js';
import groupConfigStore from '../../store/groupConfigStore.js';
import logger from '#logger';
import { sendAndStore } from '../../services/messaging/messagePersistenceService.js';
import { extractSenderInfoFromMessage, resolveUserId } from '../../config/index.js';
import { executeQuery, TABLES } from '../../../database/index.js';

/**
 * Base de redes conhecidas e seus domínios oficiais para permitir por categoria.
 * @type {Record<string, string[]>}
 */
export const KNOWN_NETWORKS = {
  youtube: ['youtube.com', 'youtu.be', 'music.youtube.com', 'm.youtube.com', 'shorts.youtube.com', 'youtube-nocookie.com'],
  instagram: ['instagram.com', 'instagr.am'],
  facebook: ['facebook.com', 'fb.com', 'fb.watch', 'm.facebook.com', 'l.facebook.com'],
  tiktok: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
  twitter: ['twitter.com', 'x.com', 't.co', 'mobile.twitter.com'],
  linkedin: ['linkedin.com', 'lnkd.in'],
  twitch: ['twitch.tv', 'clips.twitch.tv'],
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net'],
  whatsapp: ['chat.whatsapp.com', 'wa.me'],
  telegram: ['t.me', 'telegram.me', 'telesco.pe'],
  reddit: ['reddit.com', 'redd.it'],
  pinterest: ['pinterest.com', 'pin.it'],
  snapchat: ['snapchat.com', 'snap.com'],
  kwai: ['kwai.com', 'kw.ai'],
  likee: ['likee.video'],
  vimeo: ['vimeo.com', 'player.vimeo.com'],
  dailymotion: ['dailymotion.com', 'dai.ly'],
  rumble: ['rumble.com'],
  kick: ['kick.com'],
  soundcloud: ['soundcloud.com'],
  spotify: ['spotify.com', 'open.spotify.com'],
  deezer: ['deezer.com', 'deezer.page.link'],
  applemusic: ['music.apple.com'],
  shazam: ['shazam.com'],
  bandcamp: ['bandcamp.com'],
  amazonmusic: ['music.amazon.com'],
  imdb: ['imdb.com'],
  letterboxd: ['letterboxd.com'],
  goodreads: ['goodreads.com'],
  medium: ['medium.com'],
  substack: ['substack.com'],
  behance: ['behance.net'],
  dribbble: ['dribbble.com'],
  deviantart: ['deviantart.com'],
  artstation: ['artstation.com'],
  figma: ['figma.com', 'figma.io'],
  github: ['github.com', 'gist.github.com', 'github.io'],
  gitlab: ['gitlab.com'],
  bitbucket: ['bitbucket.org'],
  npm: ['npmjs.com'],
  pypi: ['pypi.org'],
  stackoverflow: ['stackoverflow.com', 'stackexchange.com'],
  quora: ['quora.com'],
  stackshare: ['stackshare.io'],
  producthunt: ['producthunt.com'],
  hackernews: ['news.ycombinator.com'],
  google: ['google.com', 'goo.gl', 'g.co', 'maps.google.com'],
  maps: ['google.com', 'maps.google.com', 'goo.gl', 'g.page'],
  playstore: ['play.google.com'],
  appstore: ['apps.apple.com'],
  steam: ['steamcommunity.com', 'store.steampowered.com', 'steamdb.info'],
  epicgames: ['epicgames.com'],
  discordbots: ['top.gg', 'discords.com', 'discordbotlist.com'],
  cloudflare: ['cloudflare.com', 'pages.dev', 'workers.dev'],
  heroku: ['heroku.com', 'herokuapp.com'],
  vercel: ['vercel.app', 'vercel.com'],
  netlify: ['netlify.app', 'netlify.com'],
  firebase: ['firebase.google.com', 'web.app'],
  hostinger: ['hostinger.com'],
  wix: ['wix.com', 'wixsite.com'],
  squarespace: ['squarespace.com'],
  wordpress: ['wordpress.com', 'wordpress.org'],
  blogger: ['blogger.com', 'blogspot.com'],
  tumblr: ['tumblr.com'],
  weibo: ['weibo.com'],
  vk: ['vk.com'],
  okru: ['ok.ru'],
  line: ['line.me'],
  wechat: ['wechat.com', 'weixin.qq.com', 'we.chat'],
  qq: ['qq.com'],
  signal: ['signal.org'],
  skype: ['skype.com'],
  slack: ['slack.com'],
  zoom: ['zoom.us', 'zoom.com'],
  meet: ['meet.google.com'],
  teams: ['microsoft.com', 'teams.microsoft.com'],
  canva: ['canva.com'],
  notion: ['notion.so', 'notion.site'],
  trello: ['trello.com'],
  asana: ['asana.com'],
  monday: ['monday.com'],
  clickup: ['clickup.com'],
  airtable: ['airtable.com'],
  coursera: ['coursera.org'],
  udemy: ['udemy.com'],
  udacity: ['udacity.com'],
  edx: ['edx.org'],
  khanacademy: ['khanacademy.org'],
  duolingo: ['duolingo.com'],
  roblox: ['roblox.com'],
  minecraft: ['minecraft.net', 'minecraft.net.br'],
  valorant: ['valorant.com'],
  riot: ['riotgames.com'],
  leagueoflegends: ['leagueoflegends.com'],
  dota2: ['dota2.com'],
  csgo: ['counter-strike.net'],
};

/**
 * Delimitadores básicos para tokenização manual (sem regex).
 */
const WHITESPACE_CHARS = new Set([' ', '\n', '\r', '\t', '\f', '\v']);
const EDGE_PUNCTUATION_CHARS = new Set([',', '!', '?', ';', ':', ')', '(', '[', ']', '{', '}', '<', '>', '"', "'", '`', '…']);
const TOKEN_SEPARATOR_CHARS = new Set([',', ';', '|']);
const HOST_TERMINATORS = new Set(['/', '?', '#', ':', '\\', ',', ';']);
const URL_HINTS = ['https://', 'http://', 'www.'];
const STRICT_TLD_SUFFIXES = new Set(['com', 'net', 'org', 'edu', 'gov', 'mil', 'io', 'me', 'tv', 'co', 'cc', 'gg', 'gl', 'ly', 'so', 'br', 'us', 'uk', 'eu', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'be', 'ch', 'at', 'se', 'no', 'fi', 'dk', 'ie', 'pl', 'cz', 'sk', 'hu', 'ro', 'bg', 'gr', 'ru', 'ua', 'tr', 'il', 'ae', 'sa', 'qa', 'eg', 'ma', 'tn', 'dz', 'za', 'ng', 'ke', 'gh', 'in', 'pk', 'bd', 'lk', 'cn', 'jp', 'kr', 'tw', 'hk', 'sg', 'my', 'th', 'vn', 'ph', 'id', 'au', 'nz', 'ca', 'mx', 'ar', 'cl', 'pe', 'uy', 'py', 'bo', 'ec', 've', 'do', 'cu', 'pa', 'cr', 'gt', 'hn', 'ni', 'sv', 'pr', 'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'jus.br', 'mil.br', 'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.tr', 'com.sg', 'com.my', 'com.ph', 'co.in', 'firm.in', 'net.in', 'org.in', 'gen.in', 'ind.in', 'co.id', 'or.id', 'go.id', 'web.id', 'co.za', 'org.za', 'net.za', 'com.ng', 'com.gh', 'com.eg', 'com.sa', 'com.qa', 'com.ae', 'page.link', 'g.page']);
const EXTRA_TLD_SUFFIXES = new Set(['ai', 'app', 'dev', 'xyz', 'site', 'online', 'store', 'shop', 'blog', 'tech', 'cloud', 'digital', 'live', 'media', 'news', 'one', 'top', 'club', 'vip', 'fun', 'games', 'game', 'space', 'world', 'today', 'agency', 'email', 'center', 'company', 'group', 'solutions', 'systems', 'services', 'network', 'social', 'design', 'studio', 'photo', 'video', 'audio', 'music', 'art', 'wiki', 'finance', 'capital', 'money', 'loans', 'insurance', 'legal', 'law', 'health', 'care', 'clinic', 'dental', 'academy', 'school', 'college', 'university', 'education', 'training', 'support', 'chat', 'forum', 'community', 'events', 'travel', 'tours', 'hotel', 'homes', 'house', 'auto', 'cars', 'bike', 'food', 'restaurant', 'cafe', 'bar', 'pizza', 'delivery', 'fashion', 'beauty', 'style', 'fit', 'fitness', 'sports', 'download']);
const ANY_TLD_SUFFIXES = new Set([...STRICT_TLD_SUFFIXES, ...EXTRA_TLD_SUFFIXES]);
const ANTILINK_DELETE_WINDOW_MS = parseEnvInt(process.env.ANTILINK_DELETE_WINDOW_MS, 5 * 60 * 1000, 60 * 1000, 30 * 60 * 1000);
const ANTILINK_DELETE_MAX_MESSAGES = parseEnvInt(process.env.ANTILINK_DELETE_MAX_MESSAGES, 40, 1, 300);
const ANTILINK_QUERY_MAX_CANDIDATES = 20;
const ANTILINK_DELETE_WINDOW_MINUTES = Math.max(1, Math.round(ANTILINK_DELETE_WINDOW_MS / (60 * 1000)));

/**
 * Tokeniza texto por espaço/quebra de linha sem regex.
 * @param {string} text
 * @returns {string[]}
 */
const tokenizeText = (text) => {
  if (!text) return [];
  const tokens = [];
  let currentToken = '';

  for (const char of text) {
    if (WHITESPACE_CHARS.has(char)) {
      if (currentToken) {
        tokens.push(currentToken);
        currentToken = '';
      }
      continue;
    }
    currentToken += char;
  }

  if (currentToken) tokens.push(currentToken);
  return tokens;
};

/**
 * Divide tokens compostos (site.com,site2.com|site3.com) sem regex.
 * @param {string} token
 * @returns {string[]}
 */
const splitCompositeToken = (token) => {
  const parts = [];
  let currentPart = '';

  for (let i = 0; i < token.length; i += 1) {
    const char = token[i];
    const isArrowSeparator = char === '>' && i > 0 && token[i - 1] === '-';

    if (TOKEN_SEPARATOR_CHARS.has(char) || isArrowSeparator) {
      if (isArrowSeparator && currentPart.endsWith('-')) {
        currentPart = currentPart.slice(0, -1);
      }
      if (currentPart) {
        parts.push(currentPart);
        currentPart = '';
      }
      continue;
    }
    currentPart += char;
  }

  if (currentPart) parts.push(currentPart);
  return parts;
};

/**
 * Remove pontuação comum das bordas do token.
 * @param {string} token
 * @returns {string}
 */
const stripEdgePunctuation = (token) => {
  let start = 0;
  let end = token.length;

  while (start < end && EDGE_PUNCTUATION_CHARS.has(token[start])) start += 1;
  while (end > start && EDGE_PUNCTUATION_CHARS.has(token[end - 1])) end -= 1;

  return token.slice(start, end);
};

const isAsciiLetter = (char) => char >= 'a' && char <= 'z';
const isDigit = (char) => char >= '0' && char <= '9';
const isDomainLabelChar = (char) => isAsciiLetter(char) || isDigit(char) || char === '-';

/**
 * Normaliza host removendo "www." e pontos nas bordas.
 * @param {string} host
 * @returns {string}
 */
const normalizeHost = (host) => {
  if (!host) return '';
  let normalized = host.toLowerCase();

  while (normalized.startsWith('.')) {
    normalized = normalized.slice(1);
  }
  while (normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }
  while (normalized.startsWith('www.')) {
    normalized = normalized.slice(4);
  }

  return normalized;
};

/**
 * Retorna quantos labels formam o TLD conhecido (1, 2 ou 3).
 * @param {string[]} labels
 * @param {Set<string>} suffixSet
 * @returns {number}
 */
const getKnownTldLabelCount = (labels, suffixSet) => {
  if (labels.length >= 3) {
    const lastThree = labels.slice(-3).join('.');
    if (suffixSet.has(lastThree)) return 3;
  }
  if (labels.length >= 2) {
    const lastTwo = labels.slice(-2).join('.');
    if (suffixSet.has(lastTwo)) return 2;
  }
  const lastOne = labels[labels.length - 1];
  if (suffixSet.has(lastOne)) return 1;
  return 0;
};

/**
 * Conta labels de TLD somente na lista strict.
 * @param {string[]} labels
 * @returns {number}
 */
const getStrictTldLabelCount = (labels) => getKnownTldLabelCount(labels, STRICT_TLD_SUFFIXES);

/**
 * Conta labels de TLD aceitando strict + extra.
 * @param {string[]} labels
 * @returns {number}
 */
const getAnyTldLabelCount = (labels) => getKnownTldLabelCount(labels, ANY_TLD_SUFFIXES);

/**
 * Extrai o root registrável com base nos TLDs strict.
 * @param {string} domain
 * @returns {string}
 */
const getStrictRegistrableRootDomain = (domain) => {
  const labels = domain.split('.');
  const tldLabelCount = getStrictTldLabelCount(labels);
  if (tldLabelCount === 0 || labels.length <= tldLabelCount) return '';
  return labels.slice(-(tldLabelCount + 1)).join('.');
};

/**
 * Valida a estrutura do domínio sem regex.
 * @param {string} domain
 * @returns {boolean}
 */
const isValidDomainStructure = (domain) => {
  if (!domain || domain.length > 253 || !domain.includes('.')) return false;
  const labels = domain.split('.');

  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (label[0] === '-' || label[label.length - 1] === '-') return false;

    for (const char of label) {
      if (!isDomainLabelChar(char)) return false;
    }
  }

  return true;
};

/**
 * Verifica se o domínio termina com TLD/sufixo conhecido.
 * @param {string} domain
 * @returns {boolean}
 */
const hasStrictKnownTldSuffix = (domain) => {
  const labels = domain.split('.');
  return getStrictTldLabelCount(labels) > 0;
};

/**
 * Verifica se o domínio termina com TLD/sufixo conhecido (strict + extra).
 * @param {string} domain
 * @returns {boolean}
 */
const hasAnyKnownTldSuffix = (domain) => {
  const labels = domain.split('.');
  return getAnyTldLabelCount(labels) > 0;
};

const KNOWN_NETWORK_EXACT_DOMAINS = new Set();
const KNOWN_NETWORK_SUBDOMAIN_ROOTS = new Set();

for (const domains of Object.values(KNOWN_NETWORKS)) {
  for (const domain of domains) {
    const normalizedDomain = domain.toLowerCase();
    KNOWN_NETWORK_EXACT_DOMAINS.add(normalizedDomain);

    const rootDomain = getStrictRegistrableRootDomain(normalizedDomain);
    if (rootDomain) {
      KNOWN_NETWORK_SUBDOMAIN_ROOTS.add(rootDomain);
    }
  }
}

/**
 * Verifica domínios oficiais já mapeados em KNOWN_NETWORKS.
 * @param {string} domain
 * @returns {boolean}
 */
const isKnownNetworkDomain = (domain) => {
  const normalizedDomain = domain.toLowerCase();
  if (KNOWN_NETWORK_EXACT_DOMAINS.has(normalizedDomain)) return true;

  const rootDomain = getStrictRegistrableRootDomain(normalizedDomain);
  if (rootDomain && rootDomain !== normalizedDomain && KNOWN_NETWORK_SUBDOMAIN_ROOTS.has(rootDomain)) {
    return true;
  }

  // Fallback para sufixos fora da lista de TLDs (ex.: goo.gl), sem varrer array inteiro.
  let dotIndex = normalizedDomain.indexOf('.');
  while (dotIndex !== -1) {
    const parentDomain = normalizedDomain.slice(dotIndex + 1);
    if (KNOWN_NETWORK_EXACT_DOMAINS.has(parentDomain)) return true;
    dotIndex = normalizedDomain.indexOf('.', dotIndex + 1);
  }

  return false;
};

/**
 * Busca o primeiro indicativo de URL no token.
 * @param {string} token
 * @returns {number}
 */
const findUrlHintIndex = (token) => {
  let firstIndex = -1;

  for (const hint of URL_HINTS) {
    const index = token.indexOf(hint);
    if (index !== -1 && (firstIndex === -1 || index < firstIndex)) {
      firstIndex = index;
    }
  }

  return firstIndex;
};

/**
 * Extrai host de token com http(s)/www usando URL nativo.
 * @param {string} token
 * @returns {string | null}
 */
const extractDomainFromUrlToken = (token) => {
  const lowerToken = token.toLowerCase();
  const hintIndex = findUrlHintIndex(lowerToken);
  if (hintIndex === -1) return null;
  if (hintIndex > 0) {
    const previousChar = lowerToken[hintIndex - 1];
    if (previousChar === '@' || isAsciiLetter(previousChar) || isDigit(previousChar)) {
      return null;
    }
  }

  let urlCandidate = token.slice(hintIndex);
  const normalizedCandidate = urlCandidate.toLowerCase();
  if (!normalizedCandidate.startsWith('http://') && !normalizedCandidate.startsWith('https://')) {
    urlCandidate = `https://${urlCandidate}`;
  }

  try {
    const parsedUrl = new URL(urlCandidate);
    const host = normalizeHost(parsedUrl.hostname);
    if (!isValidDomainStructure(host)) return null;
    if (!hasAnyKnownTldSuffix(host) && !isKnownNetworkDomain(host)) return null;
    return host;
  } catch {
    return null;
  }
};

/**
 * Extrai host de token sem protocolo, validando domínio manualmente.
 * @param {string} token
 * @returns {string | null}
 */
const extractDomainFromPlainToken = (token) => {
  const lowerToken = token.toLowerCase();
  if (lowerToken.includes('@')) return null;

  let host = '';
  for (const char of lowerToken) {
    if (HOST_TERMINATORS.has(char)) break;
    host += char;
  }

  host = normalizeHost(host);
  if (!isValidDomainStructure(host)) return null;
  if (!hasStrictKnownTldSuffix(host) && !isKnownNetworkDomain(host)) return null;

  return host;
};

/**
 * Extrai domínios válidos de um texto sem uso de regex.
 * @param {string} text
 * @returns {string[]}
 */
export const extractDomainsNoRegex = (text) => {
  const tokens = tokenizeText(text);
  if (tokens.length === 0) return [];
  const domains = new Set();

  for (const token of tokens) {
    const partialTokens = splitCompositeToken(token);
    for (const partialToken of partialTokens) {
      const cleanedToken = stripEdgePunctuation(partialToken);
      if (!cleanedToken) continue;

      const urlDomain = extractDomainFromUrlToken(cleanedToken);
      if (urlDomain) {
        domains.add(urlDomain);
        continue;
      }

      const plainDomain = extractDomainFromPlainToken(cleanedToken);
      if (plainDomain) domains.add(plainDomain);
    }
  }

  return Array.from(domains);
};

/**
 * Normaliza e remove duplicados da allowlist.
 * @param {string[]} allowedDomains
 * @returns {string[]}
 */
const normalizeAllowedDomains = (allowedDomains = []) => {
  const normalizedDomains = new Set();

  for (const allowedDomain of allowedDomains) {
    const normalizedDomain = normalizeHost(String(allowedDomain || ''));
    if (normalizedDomain) normalizedDomains.add(normalizedDomain);
  }

  return Array.from(normalizedDomains);
};

/**
 * Aceita o domínio exato ou subdomínios de um permitido já normalizado.
 * @param {string} domain
 * @param {string[]} normalizedAllowedDomains
 * @returns {boolean}
 */
const isDomainAllowed = (domain, normalizedAllowedDomains) => normalizedAllowedDomains.some((allowedDomain) => domain === allowedDomain || domain.endsWith(`.${allowedDomain}`));

/**
 * Monta a lista final de domínios permitidos (redes conhecidas + personalizados).
 * @param {string[]} allowedNetworks
 * @param {string[]} allowedCustomDomains
 * @returns {string[]}
 */
const getAllowedDomains = (allowedNetworks = [], allowedCustomDomains = []) => {
  const domains = [];
  for (const network of allowedNetworks) {
    if (KNOWN_NETWORKS[network]) {
      domains.push(...KNOWN_NETWORKS[network]);
    }
  }
  return [...domains, ...allowedCustomDomains];
};

/**
 * Retorna true quando existir um link que não esteja na lista permitida.
 * @param {string} text
 * @param {string[]} normalizedAllowedDomains
 * @returns {boolean}
 */
export const isLinkDetected = (text, normalizedAllowedDomains = []) => {
  const domains = extractDomainsNoRegex(text);
  if (domains.length === 0) return false;
  if (normalizedAllowedDomains.length === 0) return true;
  return domains.some((domain) => !isDomainAllowed(domain, normalizedAllowedDomains));
};

const normalizeOptionalJid = (value) => {
  if (typeof value !== 'string') return '';
  return normalizeJid(value.trim());
};

const uniqueNormalizedJids = (values = []) => {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeOptionalJid(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
};

const isSameUserSafe = (jidA, jidB) => {
  if (!jidA || !jidB) return false;
  try {
    return isSameJidUser(jidA, jidB);
  } catch {
    return false;
  }
};

const isSenderBot = (botJid, candidates) => {
  const normalizedBot = normalizeOptionalJid(botJid);
  if (!normalizedBot) return false;
  return candidates.some((candidate) => isSameUserSafe(candidate, normalizedBot));
};

const resolveSenderContextForAntiLink = async ({ messageInfo, senderJid, senderIdentity }) => {
  const key = messageInfo?.key || {};
  const senderInfo = extractSenderInfoFromMessage(messageInfo);
  const resolvedByMessage = normalizeOptionalJid(await resolveUserId(senderInfo).catch(() => ''));
  const identityRaw = typeof senderIdentity === 'string' ? normalizeOptionalJid(senderIdentity) : '';
  const keyParticipant = normalizeOptionalJid(key?.participant);
  const keyParticipantAlt = normalizeOptionalJid(key?.participantAlt);
  const keyRemoteAlt = normalizeOptionalJid(key?.remoteJidAlt);
  const identityParticipant = normalizeOptionalJid(senderIdentity?.participant);
  const identityParticipantAlt = normalizeOptionalJid(senderIdentity?.participantAlt);
  const identityJid = normalizeOptionalJid(senderIdentity?.jid);
  const explicitSender = normalizeOptionalJid(senderJid);
  const senderInfoJid = normalizeOptionalJid(senderInfo?.jid);
  const senderInfoLid = normalizeOptionalJid(senderInfo?.lid);
  const senderInfoAlt = normalizeOptionalJid(senderInfo?.participantAlt);

  const senderCandidates = uniqueNormalizedJids([explicitSender, resolvedByMessage, keyParticipant, keyParticipantAlt, keyRemoteAlt, senderInfoJid, senderInfoLid, senderInfoAlt, identityParticipant, identityParticipantAlt, identityJid, identityRaw]);

  const removalCandidates = [];
  const lidCandidates = [];
  const pnCandidates = [];
  for (const candidate of senderCandidates) {
    if (isLidJid(candidate)) lidCandidates.push(candidate);
    else if (isWhatsAppJid(candidate)) pnCandidates.push(candidate);
  }
  removalCandidates.push(...lidCandidates, ...pnCandidates);

  const mentionJid = pnCandidates[0] || removalCandidates[0] || senderCandidates[0] || '';
  const primarySenderId = resolvedByMessage || explicitSender || senderInfoJid || senderInfoLid || senderCandidates[0] || '';

  return {
    senderInfo,
    senderCandidates,
    removalCandidates,
    mentionJid,
    primarySenderId,
  };
};

const removeParticipantWithFallback = async (sock, remoteJid, candidates = []) => {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      await updateGroupParticipants(sock, remoteJid, [candidate], 'remove');
      return candidate;
    } catch (error) {
      lastError = error;
      logger.debug('Falha ao remover participante com ID candidato. Tentando próximo.', {
        action: 'antilink_remove_candidate_failed',
        groupId: remoteJid,
        participantId: candidate,
        error: error?.message,
      });
    }
  }
  if (lastError) throw lastError;
  return '';
};

const resolveOperationalSocket = (sock) => {
  if (isSocketOpen(sock)) return sock;
  const activeSocket = getActiveSocket();
  if (isSocketOpen(activeSocket)) return activeSocket;
  return null;
};

const sendMessageWithFallback = async (sock, jid, content) => {
  const operationalSocket = resolveOperationalSocket(sock);
  if (operationalSocket) {
    return sendAndStore(operationalSocket, jid, content);
  }
  return runActiveSocketMethod('sendMessage', jid, content);
};

const sendDeleteWithFallback = async (sock, remoteJid, messageKey) => {
  const operationalSocket = resolveOperationalSocket(sock);
  if (operationalSocket && typeof operationalSocket.sendMessage === 'function') {
    return operationalSocket.sendMessage(remoteJid, { delete: messageKey });
  }
  return runActiveSocketMethod('sendMessage', remoteJid, { delete: messageKey });
};

const safeJsonParse = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  if (Buffer.isBuffer(value)) {
    return safeJsonParse(value.toString('utf8'), fallback);
  }
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const toTimestampMs = (value) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1e12) return numeric;
    if (numeric > 1e10) return numeric;
    if (numeric > 1e9) return numeric * 1000;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeMessageId = (value) => {
  if (value === null || value === undefined) return '';
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 255) return '';
  return normalized;
};

const buildInClause = (items = []) => items.map(() => '?').join(', ');

const isMissingCanonicalSenderColumnError = (error) => {
  const code = String(error?.code || '')
    .trim()
    .toUpperCase();
  if (code === 'ER_BAD_FIELD_ERROR') return true;
  const errno = Number(error?.errno || 0);
  if (errno === 1054) return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('canonical_sender_id') && (message.includes('unknown column') || message.includes('doesn\'t exist'));
};

const isSenderInCandidates = (senderJid, senderCandidates = []) => {
  const normalizedSender = normalizeOptionalJid(senderJid);
  if (!normalizedSender) return false;

  for (const candidate of senderCandidates) {
    const normalizedCandidate = normalizeOptionalJid(candidate);
    if (!normalizedCandidate) continue;
    if (normalizedCandidate === normalizedSender) return true;
    if (isSameUserSafe(normalizedCandidate, normalizedSender)) return true;
  }
  return false;
};

const normalizeAddressingMode = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'lid' || normalized === 'pn') return normalized;
  return '';
};

const buildDeleteMessageKey = ({ sourceKey = {}, remoteJid, messageId, senderCandidates = [], fallbackParticipant = '' }) => {
  const normalizedRemoteJid = normalizeOptionalJid(sourceKey?.remoteJid || remoteJid);
  const normalizedGroupJid = normalizeOptionalJid(remoteJid);
  if (!normalizedRemoteJid || !normalizedGroupJid || normalizedRemoteJid !== normalizedGroupJid) return null;

  const normalizedMessageId = normalizeMessageId(sourceKey?.id || messageId);
  if (!normalizedMessageId) return null;
  if (sourceKey?.fromMe === true) return null;

  const keyParticipant = normalizeOptionalJid(sourceKey?.participant || sourceKey?.participantAlt || fallbackParticipant);
  if (!keyParticipant || !isSenderInCandidates(keyParticipant, senderCandidates)) return null;

  const deleteKey = {
    remoteJid: normalizedRemoteJid,
    id: normalizedMessageId,
    fromMe: false,
    participant: keyParticipant,
  };

  const participantAlt = normalizeOptionalJid(sourceKey?.participantAlt);
  if (participantAlt && participantAlt !== keyParticipant && isSenderInCandidates(participantAlt, senderCandidates)) {
    deleteKey.participantAlt = participantAlt;
  }

  const addressingMode = normalizeAddressingMode(sourceKey?.addressingMode);
  if (addressingMode) {
    deleteKey.addressingMode = addressingMode;
  }

  return deleteKey;
};

const fetchRecentSenderMessages = async ({ remoteJid, senderCandidates = [], minimumTimestampMs, limit }) => {
  const normalizedCandidates = uniqueNormalizedJids(senderCandidates).slice(0, ANTILINK_QUERY_MAX_CANDIDATES);
  if (!normalizedCandidates.length) return [];

  const inClause = buildInClause(normalizedCandidates);
  const safeLimit = Math.max(1, Math.min(Number(limit) || ANTILINK_DELETE_MAX_MESSAGES, ANTILINK_DELETE_MAX_MESSAGES));
  const queryParams = [remoteJid, new Date(minimumTimestampMs), ...normalizedCandidates, ...normalizedCandidates, safeLimit];
  const fullQuery = `SELECT message_id, chat_id, sender_id, canonical_sender_id, raw_message, timestamp
      FROM ${TABLES.MESSAGES}
      WHERE chat_id = ?
        AND timestamp IS NOT NULL
        AND timestamp >= ?
        AND (canonical_sender_id IN (${inClause}) OR sender_id IN (${inClause}))
      ORDER BY timestamp DESC
      LIMIT ?`;

  try {
    return await executeQuery(fullQuery, queryParams);
  } catch (error) {
    if (!isMissingCanonicalSenderColumnError(error)) {
      throw error;
    }

    const fallbackParams = [remoteJid, new Date(minimumTimestampMs), ...normalizedCandidates, safeLimit];
    const fallbackQuery = `SELECT message_id, chat_id, sender_id, NULL AS canonical_sender_id, raw_message, timestamp
        FROM ${TABLES.MESSAGES}
        WHERE chat_id = ?
          AND timestamp IS NOT NULL
          AND timestamp >= ?
          AND sender_id IN (${inClause})
        ORDER BY timestamp DESC
        LIMIT ?`;

    return executeQuery(fallbackQuery, fallbackParams);
  }
};

const collectRecentDeleteKeysForSender = async ({ messageInfo, remoteJid, senderCandidates = [] }) => {
  const normalizedRemoteJid = normalizeOptionalJid(remoteJid);
  if (!normalizedRemoteJid || !isGroupJid(normalizedRemoteJid)) return [];

  const normalizedCandidates = uniqueNormalizedJids(senderCandidates).slice(0, ANTILINK_QUERY_MAX_CANDIDATES);
  if (!normalizedCandidates.length) return [];
  const preferredParticipant = normalizedCandidates.find((candidate) => isWhatsAppJid(candidate)) || normalizedCandidates[0] || '';

  const minimumTimestampMs = Date.now() - ANTILINK_DELETE_WINDOW_MS;
  const keysById = new Map();

  const currentMessageKey = buildDeleteMessageKey({
    sourceKey: messageInfo?.key || {},
    remoteJid: normalizedRemoteJid,
    senderCandidates: normalizedCandidates,
    fallbackParticipant: preferredParticipant,
  });

  if (currentMessageKey) {
    keysById.set(currentMessageKey.id, currentMessageKey);
  }

  let recentRows = [];
  try {
    recentRows = await fetchRecentSenderMessages({
      remoteJid: normalizedRemoteJid,
      senderCandidates: normalizedCandidates,
      minimumTimestampMs,
      limit: ANTILINK_DELETE_MAX_MESSAGES,
    });
  } catch (error) {
    logger.warn('Falha ao buscar mensagens recentes para limpeza de antilink.', {
      action: 'antilink_recent_fetch_error',
      groupId: normalizedRemoteJid,
      senderCandidates: normalizedCandidates,
      error: error?.message,
    });
  }

  for (const row of recentRows) {
    if (keysById.size >= ANTILINK_DELETE_MAX_MESSAGES) break;

    const rowTimestampMs = toTimestampMs(row?.timestamp);
    if (!rowTimestampMs || rowTimestampMs < minimumTimestampMs) continue;

    const rawMessage = safeJsonParse(row?.raw_message, null);
    const candidateKey = rawMessage?.key && typeof rawMessage.key === 'object' ? rawMessage.key : {};
    const fallbackParticipant = normalizeOptionalJid(row?.canonical_sender_id || row?.sender_id || preferredParticipant);
    const deleteKey = buildDeleteMessageKey({
      sourceKey: candidateKey,
      remoteJid: normalizedRemoteJid,
      messageId: row?.message_id,
      senderCandidates: normalizedCandidates,
      fallbackParticipant,
    });

    if (!deleteKey) continue;
    if (keysById.has(deleteKey.id)) continue;
    keysById.set(deleteKey.id, deleteKey);
  }

  return Array.from(keysById.values());
};

const purgeRecentMessagesFromRemovedSender = async ({ sock, messageInfo, remoteJid, senderCandidates = [] }) => {
  const deleteKeys = await collectRecentDeleteKeysForSender({
    messageInfo,
    remoteJid,
    senderCandidates,
  });

  if (!deleteKeys.length) {
    return { requested: 0, deleted: 0, failed: 0 };
  }

  let deleted = 0;
  let failed = 0;
  for (const deleteKey of deleteKeys) {
    try {
      await sendDeleteWithFallback(sock, remoteJid, deleteKey);
      deleted += 1;
    } catch (error) {
      failed += 1;
      logger.debug('Falha ao apagar mensagem durante limpeza do antilink.', {
        action: 'antilink_delete_message_failed',
        groupId: remoteJid,
        messageId: deleteKey?.id,
        participant: deleteKey?.participant || null,
        error: error?.message,
      });
    }
  }

  return {
    requested: deleteKeys.length,
    deleted,
    failed,
  };
};

/**
 * Limpa mensagens recentes (janela de segurança) de um participante alvo.
 * Pode ser reutilizado por outros fluxos de moderação (ex.: comando ban).
 * @param {Object} params
 * @param {import('@whiskeysockets/baileys').WASocket} params.sock
 * @param {Object|null|undefined} [params.messageInfo]
 * @param {string} params.remoteJid
 * @param {string[]} params.senderCandidates
 * @returns {Promise<{requested:number, deleted:number, failed:number}>}
 */
export const purgeRecentMessagesForSenderCandidates = async ({ sock, messageInfo, remoteJid, senderCandidates = [] }) =>
  purgeRecentMessagesFromRemovedSender({
    sock,
    messageInfo,
    remoteJid,
    senderCandidates,
  });

/**
 * Aplica a regra de antilink do grupo. Retorna true quando removeu e deve pular o restante.
 * @param {Object} params
 * @param {import('@whiskeysockets/baileys').WASocket} params.sock
 * @param {Object} params.messageInfo
 * @param {string} params.extractedText
 * @param {string} params.remoteJid
 * @param {string} params.senderJid
 * @param {{participant?: string|null, participantAlt?: string|null, jid?: string|null}|string|null} [params.senderIdentity]
 * @param {string} params.botJid
 * @returns {Promise<boolean>}
 */
export const handleAntiLink = async ({ sock, messageInfo, extractedText, remoteJid, senderJid, senderIdentity, botJid }) => {
  const normalizedRemoteJid = normalizeOptionalJid(remoteJid);
  if (!normalizedRemoteJid || !isGroupJid(normalizedRemoteJid)) return false;

  const groupConfig = await groupConfigStore.getGroupConfig(normalizedRemoteJid);
  if (!groupConfig || !groupConfig.antilinkEnabled) return false;

  const allowedDomains = getAllowedDomains(groupConfig.antilinkAllowedNetworks || [], groupConfig.antilinkAllowedDomains || []);
  const normalizedAllowedDomains = normalizeAllowedDomains(allowedDomains);
  if (!isLinkDetected(extractedText, normalizedAllowedDomains)) return false;

  const senderContext = await resolveSenderContextForAntiLink({
    messageInfo,
    senderJid,
    senderIdentity,
  });
  if (!senderContext.primarySenderId && senderContext.senderCandidates.length === 0) return false;

  let isAdmin = await isUserAdmin(normalizedRemoteJid, {
    id: senderContext.primarySenderId || null,
    jid: senderContext.senderInfo?.jid || senderContext.primarySenderId || null,
    lid: senderContext.senderInfo?.lid || null,
    participantAlt: senderContext.senderInfo?.participantAlt || null,
    participant: messageInfo?.key?.participant || null,
    remoteJidAlt: messageInfo?.key?.remoteJidAlt || null,
  });

  if (!isAdmin && senderContext.primarySenderId) {
    isAdmin = await isUserAdmin(normalizedRemoteJid, senderContext.primarySenderId);
  }

  const senderIsBot = isSenderBot(botJid, senderContext.senderCandidates);

  if (!isAdmin && !senderIsBot) {
    if (senderContext.removalCandidates.length === 0) {
      logger.warn('Antilink detectou link, mas não encontrou ID válido para remoção.', {
        action: 'antilink_no_removal_candidate',
        groupId: normalizedRemoteJid,
        senderCandidates: senderContext.senderCandidates,
      });
      return false;
    }

    try {
      const removedParticipantId = await removeParticipantWithFallback(sock, normalizedRemoteJid, senderContext.removalCandidates);
      if (!removedParticipantId) {
        throw new Error('Nenhum candidato de participante pôde ser removido.');
      }

      const deletionCandidates = uniqueNormalizedJids([removedParticipantId, ...senderContext.senderCandidates]);
      const purgeResult = await purgeRecentMessagesFromRemovedSender({
        sock,
        messageInfo,
        remoteJid: normalizedRemoteJid,
        senderCandidates: deletionCandidates,
      });

      const senderMention = senderContext.mentionJid || removedParticipantId || senderContext.primarySenderId;
      const senderUser = getJidUser(senderMention);
      const recentDeleteLine = purgeResult.deleted > 0 ? `\n🧹 ${purgeResult.deleted} mensagem(ns) dos últimos ${ANTILINK_DELETE_WINDOW_MINUTES} minuto(s) foram apagadas.` : '';
      await sendMessageWithFallback(sock, normalizedRemoteJid, {
        text: `🚫 @${senderUser || 'usuario'} foi removido por enviar um link.${recentDeleteLine}`,
        mentions: senderMention ? [senderMention] : [],
      });

      logger.info(`Usuário ${removedParticipantId || senderContext.primarySenderId} removido do grupo ${normalizedRemoteJid} por enviar link.`, {
        action: 'antilink_remove',
        groupId: normalizedRemoteJid,
        userId: removedParticipantId || senderContext.primarySenderId,
        senderCandidates: senderContext.senderCandidates,
        deletedRecentMessages: purgeResult.deleted,
        failedRecentMessageDeletes: purgeResult.failed,
        requestedRecentMessageDeletes: purgeResult.requested,
      });

      return true;
    } catch (error) {
      logger.error(`Falha ao remover usuário com antilink: ${error.message}`, {
        action: 'antilink_error',
        groupId: normalizedRemoteJid,
        userId: senderContext.primarySenderId,
        senderCandidates: senderContext.senderCandidates,
        error: error.stack,
      });
    }
  } else if (isAdmin && !senderIsBot) {
    try {
      const senderMention = senderContext.mentionJid || senderContext.primarySenderId;
      const senderUser = getJidUser(senderMention);
      await sendMessageWithFallback(sock, normalizedRemoteJid, {
        text: `ⓘ @${senderUser || 'admin'} (admin) enviou um link.`,
        mentions: senderMention ? [senderMention] : [],
      });
      logger.info(`Admin ${senderContext.primarySenderId} enviou um link no grupo ${normalizedRemoteJid} (aviso enviado).`, {
        action: 'antilink_admin_link_detected',
        groupId: normalizedRemoteJid,
        userId: senderContext.primarySenderId,
      });
    } catch (error) {
      logger.error(`Falha ao enviar aviso de link de admin: ${error.message}`, {
        action: 'antilink_admin_warning_error',
        groupId: normalizedRemoteJid,
        userId: senderContext.primarySenderId,
        error: error.stack,
      });
    }
  }

  return false;
};
