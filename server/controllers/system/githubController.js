import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import logger from '#logger';
import { toIsoOrNull } from '../../http/httpRequestUtils.js';

const GITHUB_REPOSITORY = String(process.env.GITHUB_REPOSITORY || 'Omnizap-System/omnizap').trim();
const GITHUB_TOKEN = String(process.env.GITHUB_TOKEN || '').trim();
const GITHUB_PROJECT_CACHE_SECONDS = Number(process.env.GITHUB_PROJECT_CACHE_SECONDS || 300);

const GITHUB_PROJECT_CACHE = {
  expiresAt: 0,
  value: null,
};

const normalizeGitHubRepo = (value) => {
  const raw = String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '');
  const [owner, repo] = raw.split('/').filter(Boolean);
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
  };
};

const GITHUB_REPO_INFO = normalizeGitHubRepo(GITHUB_REPOSITORY);

const githubFetchJson = async (url) => {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('fetch indisponivel');
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'omnizap/2.1',
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  const response = await globalThis.fetch(url, { headers });
  if (!response.ok) {
    const error = new Error(`GitHub HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
};

const githubFetchJsonSafe = async (url, fallbackValue) => {
  try {
    return await githubFetchJson(url);
  } catch {
    return fallbackValue;
  }
};

const mapGitHubProjectSummary = (repoData, latestReleaseData, releasesData = [], commitsData = [], languagesData = {}, openPrs = null) => ({
  repository: repoData?.full_name || GITHUB_REPO_INFO?.fullName || null,
  html_url: repoData?.html_url || (GITHUB_REPO_INFO ? `https://github.com/${GITHUB_REPO_INFO.fullName}` : null),
  description: repoData?.description || null,
  stars: Number(repoData?.stargazers_count || 0),
  forks: Number(repoData?.forks_count || 0),
  open_issues: Number(repoData?.open_issues_count || 0),
  open_prs: Number.isFinite(Number(openPrs)) ? Number(openPrs) : null,
  watchers: Number(repoData?.subscribers_count || repoData?.watchers_count || 0),
  language: repoData?.language || null,
  languages: Object.entries(languagesData || {})
    .map(([name, bytes]) => ({ name, bytes: Number(bytes || 0) }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 6),
  topics: Array.isArray(repoData?.topics) ? repoData.topics : [],
  size_kb: Number(repoData?.size || 0),
  default_branch: repoData?.default_branch || null,
  license: repoData?.license?.spdx_id || repoData?.license?.name || null,
  created_at: toIsoOrNull(repoData?.created_at),
  updated_at: toIsoOrNull(repoData?.updated_at),
  pushed_at: toIsoOrNull(repoData?.pushed_at),
  latest_release: latestReleaseData
    ? {
        tag: latestReleaseData.tag_name || null,
        name: latestReleaseData.name || null,
        published_at: toIsoOrNull(latestReleaseData.published_at),
        html_url: latestReleaseData.html_url || null,
      }
    : null,
  latest_releases: (Array.isArray(releasesData) ? releasesData : []).slice(0, 5).map((release) => ({
    tag: release?.tag_name || null,
    name: release?.name || null,
    html_url: release?.html_url || null,
    draft: Boolean(release?.draft),
    prerelease: Boolean(release?.prerelease),
    published_at: toIsoOrNull(release?.published_at),
  })),
  latest_commits: (Array.isArray(commitsData) ? commitsData : []).slice(0, 5).map((commit) => ({
    sha: String(commit?.sha || '').slice(0, 7) || null,
    html_url: commit?.html_url || null,
    message: String(commit?.commit?.message || '').split('\n')[0] || null,
    author: commit?.commit?.author?.name || commit?.author?.login || null,
    date: toIsoOrNull(commit?.commit?.author?.date),
  })),
});

export const fetchGitHubProjectSummary = async () => {
  if (!GITHUB_REPO_INFO) {
    throw new Error('GITHUB_REPOSITORY invalido');
  }

  const now = __timeNowMs();
  if (GITHUB_PROJECT_CACHE.value && now < GITHUB_PROJECT_CACHE.expiresAt) {
    return GITHUB_PROJECT_CACHE.value;
  }

  const repoUrl = `https://api.github.com/repos/${encodeURIComponent(GITHUB_REPO_INFO.owner)}/${encodeURIComponent(GITHUB_REPO_INFO.repo)}`;
  const releasesUrl = `${repoUrl}/releases?per_page=5`;
  const commitsUrl = `${repoUrl}/commits?per_page=5`;
  const languagesUrl = `${repoUrl}/languages`;
  const openPrsUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${GITHUB_REPO_INFO.fullName} is:pr is:open`)}&per_page=1`;

  try {
    const repoData = await githubFetchJson(repoUrl);
    const [releasesData, commitsData, languagesData, openPrsData] = await Promise.all([githubFetchJsonSafe(releasesUrl, []), githubFetchJsonSafe(commitsUrl, []), githubFetchJsonSafe(languagesUrl, {}), githubFetchJsonSafe(openPrsUrl, { total_count: null })]);

    const latestReleaseData = Array.isArray(releasesData) ? releasesData[0] || null : null;
    const summary = mapGitHubProjectSummary(repoData, latestReleaseData, releasesData, commitsData, languagesData, openPrsData?.total_count);
    GITHUB_PROJECT_CACHE.value = summary;
    GITHUB_PROJECT_CACHE.expiresAt = now + GITHUB_PROJECT_CACHE_SECONDS * 1000;
    return summary;
  } catch (error) {
    logger.error('Erro ao buscar resumo do GitHub', { error: error?.message });
    if (GITHUB_PROJECT_CACHE.value) return GITHUB_PROJECT_CACHE.value;
    throw error;
  }
};
