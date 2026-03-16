import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
const DEFAULT_SITE_ORIGIN = 'https://omnizap.shop';
const DEFAULT_BRAND_NAME = 'OmniZap';

const resolveSiteOrigin = () =>
  String(process.env.SITE_ORIGIN || process.env.WHATSAPP_LOGIN_BASE_URL || DEFAULT_SITE_ORIGIN)
    .trim()
    .replace(/\/+$/, '') || DEFAULT_SITE_ORIGIN;

const normalizeTemplateKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, '')
    .slice(0, 64);

const normalizeText = (value, maxLength = 500) =>
  String(value || '')
    .trim()
    .slice(0, maxLength);

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const normalizeHttpUrl = (value, fallback = '') => {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, '');
  if (!normalized) return fallback;
  if (!/^https?:\/\//i.test(normalized)) return fallback;
  return normalized.slice(0, 2_000);
};

const normalizeEmailAddress = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const betweenAngles = raw.match(/<([^>]+)>/);
  const candidate = String(betweenAngles?.[1] || raw)
    .trim()
    .replace(/^mailto:/i, '');
  if (!candidate.includes('@')) return '';
  return candidate.slice(0, 255);
};

const normalizePhoneDigits = (value, maxLength = 20) =>
  String(value || '')
    .replace(/\D+/g, '')
    .slice(0, maxLength);

const isLikelyPhoneDigits = (digits) => {
  const normalized = normalizePhoneDigits(digits, 20);
  return normalized.length >= 10 && normalized.length <= 15;
};

const formatPhonePn = (digits) => {
  const normalized = normalizePhoneDigits(digits, 20);
  if (!normalized) return '';

  if (normalized.length === 13 && normalized.startsWith('55')) {
    return `+${normalized.slice(0, 2)} ${normalized.slice(2, 4)} ${normalized.slice(4, 9)}-${normalized.slice(9, 13)}`;
  }

  if (normalized.length === 12 && normalized.startsWith('55')) {
    return `+${normalized.slice(0, 2)} ${normalized.slice(2, 4)} ${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
  }

  return `+${normalized}`;
};

const resolveBrandConfig = (payload = {}) => {
  const siteOrigin = normalizeHttpUrl(payload?.siteOrigin || resolveSiteOrigin(), resolveSiteOrigin());
  const supportFallback = `${siteOrigin}/termos-de-uso/`;
  const replyToAddress = normalizeEmailAddress(payload?.replyTo || process.env.SMTP_REPLY_TO || process.env.EMAIL_REPLY_TO || process.env.MAIL_REPLY_TO || '');
  const fromAddress = normalizeEmailAddress(process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.MAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || process.env.MAIL_USER || '');
  const supportPhoneCandidate = normalizePhoneDigits(payload?.supportPhone || process.env.EMAIL_BRAND_SUPPORT_PHONE || process.env.WHATSAPP_SUPPORT_NUMBER || process.env.OWNER_NUMBER || '', 20);
  const supportPhoneDigits = isLikelyPhoneDigits(supportPhoneCandidate) ? supportPhoneCandidate : '';
  const supportPhonePn = formatPhonePn(supportPhoneDigits);
  const supportWhatsappUrl = supportPhoneDigits ? `https://wa.me/${supportPhoneDigits}` : '';
  const resolvedSupportUrl = normalizeHttpUrl(payload?.supportUrl || supportWhatsappUrl || process.env.EMAIL_BRAND_SUPPORT_URL || supportFallback, supportFallback);
  const resolvedSupportLabel = normalizeText(payload?.supportLabel || supportPhonePn || process.env.EMAIL_BRAND_SUPPORT_LABEL || 'Central de suporte', 80);

  return {
    siteOrigin,
    brandName: normalizeText(payload?.brandName || process.env.EMAIL_BRAND_NAME || DEFAULT_BRAND_NAME, 80) || DEFAULT_BRAND_NAME,
    brandTagline: normalizeText(payload?.brandTagline || process.env.EMAIL_BRAND_TAGLINE || 'Automação profissional para WhatsApp.', 120) || null,
    brandLogoUrl: normalizeHttpUrl(payload?.brandLogoUrl || payload?.logoUrl || process.env.EMAIL_BRAND_LOGO_URL || '', ''),
    supportUrl: resolvedSupportUrl,
    supportLabel: resolvedSupportLabel || 'Central de suporte',
    supportEmail: replyToAddress || fromAddress || '',
  };
};

const renderParagraphsHtml = (value, { maxParagraphs = 6, maxLength = 8_000 } = {}) => {
  const normalized = String(value || '')
    .replace(/\r/g, '')
    .trim()
    .slice(0, maxLength);
  if (!normalized) return '';

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, maxParagraphs);

  if (!paragraphs.length) return '';

  return paragraphs.map((paragraph) => `<p style="margin:0 0 12px;color:#334155;font-size:15px;line-height:1.65;">${escapeHtml(paragraph)}</p>`).join('');
};

const renderEmailLayout = ({ payload = {}, preheader = '', heading = '', greeting = '', intro = '', body = '', ctaLabel = '', ctaUrl = '', ctaHint = '', secondaryCtaLabel = '', secondaryCtaUrl = '', securityNote = '', footerMessage = '' } = {}) => {
  const brand = resolveBrandConfig(payload);
  const safePreheader = normalizeText(preheader, 160);
  const safeHeading = normalizeText(heading, 120);
  const safeGreeting = normalizeText(greeting, 150);
  const safeIntro = normalizeText(intro, 300);
  const safeCtaLabel = normalizeText(ctaLabel, 80);
  const safeCtaUrl = normalizeHttpUrl(ctaUrl, '');
  const safeCtaHint = normalizeText(ctaHint, 220);
  const safeSecondaryCtaLabel = normalizeText(secondaryCtaLabel, 80);
  const safeSecondaryCtaUrl = normalizeHttpUrl(secondaryCtaUrl, '');
  const safeSecurityNote = normalizeText(securityNote, 220);
  const safeFooterMessage = normalizeText(footerMessage, 220);
  const year = __timeNow().getUTCFullYear();

  const logoBlock = brand.brandLogoUrl ? `<img src="${escapeHtml(brand.brandLogoUrl)}" alt="${escapeHtml(brand.brandName)}" width="132" style="display:block;border:0;outline:none;text-decoration:none;height:auto;margin:0 auto;" />` : `<div style="display:inline-block;font-size:26px;font-weight:800;color:#0f172a;letter-spacing:0.2px;">${escapeHtml(brand.brandName)}</div>`;

  const greetingBlock = safeGreeting ? `<p style="margin:0 0 10px;color:#0f172a;font-size:16px;font-weight:700;line-height:1.5;">${escapeHtml(safeGreeting)}</p>` : '';
  const introBlock = safeIntro ? `<p style="margin:0 0 14px;color:#334155;font-size:15px;line-height:1.65;">${escapeHtml(safeIntro)}</p>` : '';
  const bodyBlock = renderParagraphsHtml(body);

  const ctaBlock =
    safeCtaUrl && safeCtaLabel
      ? `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 10px;">
          <tr>
            <td align="center" bgcolor="#1d4ed8" style="border-radius:10px;">
              <a href="${escapeHtml(safeCtaUrl)}" style="display:inline-block;padding:12px 20px;font-size:15px;line-height:1.2;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(safeCtaLabel)}</a>
            </td>
          </tr>
        </table>
      `.trim()
      : '';

  const ctaHintBlock = safeCtaHint ? `<p style="margin:4px 0 0;color:#64748b;font-size:13px;line-height:1.55;">${escapeHtml(safeCtaHint)}</p>` : '';
  const secondaryCtaBlock = safeSecondaryCtaLabel && safeSecondaryCtaUrl ? `<p style="margin:10px 0 0;color:#1e293b;font-size:14px;line-height:1.6;">${escapeHtml(safeSecondaryCtaLabel)}: <a href="${escapeHtml(safeSecondaryCtaUrl)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(safeSecondaryCtaUrl)}</a></p>` : '';
  const fallbackLinkBlock = safeCtaUrl ? `<p style="margin:12px 0 0;color:#64748b;font-size:12px;line-height:1.6;word-break:break-all;">Se o botão não funcionar, copie e cole este link no navegador: ${escapeHtml(safeCtaUrl)}</p>` : '';
  const securityNoteBlock = safeSecurityNote ? `<p style="margin:16px 0 0;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;color:#475569;font-size:12px;line-height:1.6;">${escapeHtml(safeSecurityNote)}</p>` : '';

  const supportEmailLine = brand.supportEmail ? `<span style="display:block;margin-top:6px;">E-mail: <a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(brand.supportEmail)}</a></span>` : '';
  const footerMessageBlock = safeFooterMessage ? `<span style="display:block;margin-top:6px;color:#64748b;">${escapeHtml(safeFooterMessage)}</span>` : '';
  const taglineBlock = brand.brandTagline ? `<p style="margin:8px 0 0;color:#64748b;font-size:13px;line-height:1.6;">${escapeHtml(brand.brandTagline)}</p>` : '';

  return `
<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(safePreheader)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;padding:28px 10px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;">
            <tr>
              <td align="center" style="padding:0 0 16px;">
                ${logoBlock}
                ${taglineBlock}
              </td>
            </tr>
            <tr>
              <td style="background:#ffffff;border:1px solid #dbe3ef;border-radius:14px;padding:26px 24px;box-shadow:0 4px 24px rgba(15,23,42,0.06);">
                <h1 style="margin:0 0 14px;color:#0f172a;font-size:25px;line-height:1.25;">${escapeHtml(safeHeading)}</h1>
                ${greetingBlock}
                ${introBlock}
                ${bodyBlock}
                ${ctaBlock}
                ${ctaHintBlock}
                ${secondaryCtaBlock}
                ${fallbackLinkBlock}
                ${securityNoteBlock}
              </td>
            </tr>
            <tr>
              <td style="padding:14px 2px 0;color:#64748b;font-size:12px;line-height:1.7;text-align:left;">
                <span style="display:block;">${escapeHtml(brand.brandName)} © ${year}. Todos os direitos reservados.</span>
                <span style="display:block;margin-top:6px;">Central de suporte: <a href="${escapeHtml(brand.supportUrl)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(brand.supportLabel)}</a></span>
                ${supportEmailLine}
                ${footerMessageBlock}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
};

const resolveNavigationLinks = (payload = {}) => {
  const siteOrigin = normalizeHttpUrl(payload?.siteOrigin || resolveSiteOrigin(), resolveSiteOrigin());
  const defaultRedirectUrl = normalizeHttpUrl(process.env.EMAIL_DEFAULT_REDIRECT_URL || `${siteOrigin}/user/`, `${siteOrigin}/user/`);
  const defaultHomeUrl = normalizeHttpUrl(process.env.EMAIL_DEFAULT_CTA_URL || `${siteOrigin}/`, `${siteOrigin}/`);
  const redirectUrl = normalizeHttpUrl(payload?.redirectUrl || payload?.userUrl || payload?.loginUrl || defaultRedirectUrl, defaultRedirectUrl);
  const homeUrl = normalizeHttpUrl(payload?.ctaUrl || payload?.homeUrl || payload?.link || defaultHomeUrl, defaultHomeUrl);

  return {
    siteOrigin,
    redirectUrl,
    homeUrl,
  };
};

const resolveWelcomeBotWhatsApp = (payload = {}) => {
  const botPhoneCandidate = normalizePhoneDigits(payload?.botPhone || payload?.botNumber || process.env.EMAIL_WELCOME_BOT_PHONE || process.env.WHATSAPP_BOT_NUMBER || process.env.BOT_NUMBER || process.env.BOT_PHONE_NUMBER || process.env.PHONE_NUMBER || process.env.EMAIL_BRAND_SUPPORT_PHONE || '', 20);
  const botPhoneDigits = isLikelyPhoneDigits(botPhoneCandidate) ? botPhoneCandidate : '';
  const botPhonePn = formatPhonePn(botPhoneDigits);
  const botWhatsAppUrl = botPhoneDigits ? `https://wa.me/${botPhoneDigits}` : '';

  return {
    botPhonePn,
    botWhatsAppUrl,
  };
};

const resolveTermsUrl = (payload = {}) => {
  const siteOrigin = normalizeHttpUrl(payload?.siteOrigin || resolveSiteOrigin(), resolveSiteOrigin());
  const defaultTermsUrl = normalizeHttpUrl(`${siteOrigin}/termos-de-uso/`, `${DEFAULT_SITE_ORIGIN}/termos-de-uso/`);
  return normalizeHttpUrl(payload?.termsUrl || process.env.EMAIL_TERMS_URL || defaultTermsUrl, defaultTermsUrl);
};

const buildWelcomeTemplate = (payload = {}) => {
  const name = normalizeText(payload?.name || payload?.firstName || '', 80) || 'você';
  const { redirectUrl, homeUrl } = resolveNavigationLinks(payload);
  const { botPhonePn, botWhatsAppUrl } = resolveWelcomeBotWhatsApp(payload);
  const ctaUrl = botWhatsAppUrl || homeUrl;
  const ctaLabel = botWhatsAppUrl ? 'Abrir WhatsApp do Bot' : 'Abrir OmniZap';
  const ctaHint = botPhonePn ? `WhatsApp do bot: ${botPhonePn}` : `Link de redirecionamento: ${redirectUrl}`;
  const subject = 'Bem-vindo(a) ao OmniZap';

  return {
    subject,
    text: [`Olá, ${name}!`, '', 'Sua conta no OmniZap foi preparada e já está pronta para uso.', `Redirecionamento da conta: ${redirectUrl}`, botWhatsAppUrl ? `WhatsApp do bot: ${botWhatsAppUrl}` : `Abrir plataforma: ${homeUrl}`, '', 'Se você não solicitou este e-mail, desconsidere esta mensagem.'].join('\n'),
    html: renderEmailLayout({
      payload,
      preheader: 'Sua conta no OmniZap está pronta para uso.',
      heading: 'Bem-vindo(a) ao OmniZap',
      greeting: `Olá, ${name}!`,
      intro: 'Sua conta foi preparada com sucesso. Use o botão abaixo para abrir o WhatsApp do bot.',
      ctaLabel,
      ctaUrl,
      ctaHint,
      securityNote: 'Se você não reconhece esta ação, ignore este e-mail.',
      footerMessage: 'Este e-mail foi enviado automaticamente pelo sistema.',
    }),
  };
};

const buildMagicLinkTemplate = (payload = {}) => {
  const name = normalizeText(payload?.name || payload?.firstName || '', 80) || 'você';
  const link = normalizeHttpUrl(payload?.link || payload?.magicLink || payload?.loginUrl || '', '');
  if (!link) return null;

  const expiresInMinutes = Number(payload?.expiresInMinutes);
  const expirationMessage = Number.isFinite(expiresInMinutes) && expiresInMinutes > 0 ? `Este link expira em ${Math.max(1, Math.floor(expiresInMinutes))} minuto(s).` : 'Este link pode expirar em alguns minutos.';
  const subject = 'Seu link de acesso ao OmniZap';

  return {
    subject,
    text: [`Olá, ${name}!`, '', 'Use o link abaixo para acessar sua conta com segurança:', link, '', expirationMessage, 'Se você não solicitou este acesso, ignore esta mensagem.'].join('\n'),
    html: renderEmailLayout({
      payload,
      preheader: 'Use seu link de acesso seguro do OmniZap.',
      heading: 'Seu link de acesso',
      greeting: `Olá, ${name}!`,
      intro: 'Clique no botão abaixo para entrar na sua conta.',
      ctaLabel: 'Acessar conta',
      ctaUrl: link,
      ctaHint: expirationMessage,
      securityNote: 'Não compartilhe este link com terceiros.',
      footerMessage: 'Para sua segurança, este link é pessoal e temporário.',
    }),
  };
};

const buildPasswordResetCodeTemplate = (payload = {}) => {
  const name = normalizeText(payload?.name || payload?.firstName || '', 80) || 'você';
  const codeDigits = String(payload?.code || '')
    .replace(/\D+/g, '')
    .slice(0, 6);
  if (!/^\d{6}$/.test(codeDigits)) return null;

  const purpose = normalizeText(payload?.purpose || 'reset', 24).toLowerCase() === 'setup' ? 'setup' : 'reset';
  const expiresInMinutesRaw = Number(payload?.expiresInMinutes);
  const expiresInMinutes = Number.isFinite(expiresInMinutesRaw) ? Math.max(1, Math.min(60, Math.floor(expiresInMinutesRaw))) : 15;
  const purposeLabel = purpose === 'setup' ? 'criação de senha' : 'redefinição de senha';
  const subject = purpose === 'setup' ? 'Codigo para criar sua senha no OmniZap' : 'Codigo para redefinir sua senha no OmniZap';
  const codeDisplay = `${codeDigits.slice(0, 3)} ${codeDigits.slice(3, 6)}`;

  return {
    subject,
    text: [`Olá, ${name}!`, '', `Use este código para concluir a ${purposeLabel}:`, codeDigits, '', `Este código expira em ${expiresInMinutes} minuto(s).`, 'Se você não solicitou esta ação, ignore este e-mail.'].join('\n'),
    html: renderEmailLayout({
      payload,
      preheader: `Seu código de ${purposeLabel} do OmniZap.`,
      heading: purpose === 'setup' ? 'Criacao de senha' : 'Redefinicao de senha',
      greeting: `Olá, ${name}!`,
      intro: `Use o codigo abaixo para concluir a ${purposeLabel}.`,
      body: `Codigo de verificacao: ${codeDisplay}\nValidade: ${expiresInMinutes} minuto(s).`,
      ctaLabel: '',
      ctaUrl: '',
      ctaHint: '',
      securityNote: 'Nao compartilhe este codigo com terceiros. A equipe OmniZap nunca pede esse codigo por mensagem.',
      footerMessage: 'Mensagem automatica de seguranca do OmniZap.',
    }),
  };
};

const buildProjectUpdateTemplate = (payload = {}) => {
  const name = normalizeText(payload?.name || payload?.firstName || '', 80) || 'usuário';
  const title = normalizeText(payload?.title || payload?.heading || 'Atualização do projeto OmniZap', 120) || 'Atualização do projeto OmniZap';
  const message = normalizeText(payload?.message || payload?.body || 'Temos uma nova atualização do projeto. Confira os detalhes no painel.', 6_000) || 'Temos uma nova atualização do projeto. Confira os detalhes no painel.';
  const details = normalizeText(payload?.details || '', 6_000);
  const ctaUrl = normalizeHttpUrl(payload?.ctaUrl || payload?.link || payload?.loginUrl || '', '');
  const ctaLabel = normalizeText(payload?.ctaLabel || 'Ver atualização', 80) || 'Ver atualização';
  const subject = normalizeText(payload?.subject || title, 180) || title;

  const textLines = [`Olá, ${name}!`, '', title, '', message];
  if (details) {
    textLines.push('', details);
  }
  if (ctaUrl) {
    textLines.push('', `Acesse: ${ctaUrl}`);
  }
  textLines.push('', 'Mensagem automática do OmniZap.');

  return {
    subject,
    text: textLines.join('\n'),
    html: renderEmailLayout({
      payload,
      preheader: title,
      heading: title,
      greeting: `Olá, ${name}!`,
      intro: message,
      body: details,
      ctaLabel: ctaUrl ? ctaLabel : '',
      ctaUrl,
      ctaHint: ctaUrl ? 'Abra o link para ver os detalhes completos.' : '',
      securityNote: 'Se você não reconhece esta comunicação, entre em contato com o suporte.',
      footerMessage: 'Comunicado oficial do projeto OmniZap.',
    }),
  };
};

const buildStandardTemplate = (payload = {}) => {
  const { redirectUrl, homeUrl } = resolveNavigationLinks(payload);
  const name = normalizeText(payload?.name || payload?.firstName || '', 80);
  const subject = normalizeText(payload?.subject || payload?.title || 'Comunicado OmniZap', 180) || 'Comunicado OmniZap';
  const heading = normalizeText(payload?.heading || payload?.title || 'Atualização OmniZap', 120) || 'Atualização OmniZap';
  const intro = normalizeText(payload?.intro || payload?.message || payload?.summary || 'Temos uma nova comunicação para você.', 2_000);
  const details = normalizeText(payload?.body || payload?.details || '', 6_000);
  const ctaUrl = homeUrl;
  const ctaLabel = normalizeText(payload?.ctaLabel || 'Abrir OmniZap', 80) || 'Abrir OmniZap';
  const ctaHint = normalizeText(payload?.ctaHint || `Link de redirecionamento: ${redirectUrl}`, 220);
  const securityNote = normalizeText(payload?.securityNote || 'Se não reconhece esta mensagem, ignore e entre em contato com o suporte.', 220) || 'Se não reconhece esta mensagem, ignore e entre em contato com o suporte.';
  const footerMessage = normalizeText(payload?.footerMessage || 'Mensagem automática do projeto OmniZap.', 220);
  const greeting = name ? `Olá, ${name}!` : '';

  const textLines = [];
  if (greeting) {
    textLines.push(greeting, '');
  }
  textLines.push(heading, '');
  if (intro) {
    textLines.push(intro);
  }
  if (details) {
    textLines.push('', details);
  }
  if (redirectUrl) {
    textLines.push('', `Redirecionamento da conta: ${redirectUrl}`);
  }
  if (ctaUrl) {
    textLines.push('', `Abrir plataforma: ${ctaUrl}`);
  }
  textLines.push('', 'Mensagem automática do OmniZap.');

  return {
    subject,
    text: textLines.join('\n'),
    html: renderEmailLayout({
      payload,
      preheader: heading,
      heading,
      greeting,
      intro,
      body: details,
      ctaLabel: ctaUrl ? ctaLabel : '',
      ctaUrl,
      ctaHint: ctaUrl ? ctaHint : '',
      securityNote,
      footerMessage,
    }),
  };
};

const buildTermsUpdateTemplate = (payload = {}) => {
  const name = normalizeText(payload?.name || payload?.firstName || '', 80) || 'usuário';
  const { botPhonePn, botWhatsAppUrl } = resolveWelcomeBotWhatsApp(payload);
  const termsUrl = resolveTermsUrl(payload);
  const fallbackOpenUrl = normalizeHttpUrl(process.env.EMAIL_DEFAULT_CTA_URL || `${resolveSiteOrigin()}/`, `${resolveSiteOrigin()}/`);
  const ctaUrl = botWhatsAppUrl || fallbackOpenUrl;
  const ctaLabel = botWhatsAppUrl ? 'Abrir WhatsApp do Bot' : 'Abrir OmniZap';
  const subject = normalizeText(payload?.subject || 'Atualização dos Termos de Serviço do OmniZap', 180) || 'Atualização dos Termos de Serviço do OmniZap';
  const heading = normalizeText(payload?.heading || 'Atualização dos Termos de Serviço', 120) || 'Atualização dos Termos de Serviço';
  const intro = normalizeText(payload?.intro || payload?.message || 'Atualizamos nossos Termos de Serviço para refletir melhorias operacionais, de segurança e de comunicação do projeto.', 2_000) || 'Atualizamos nossos Termos de Serviço para refletir melhorias operacionais, de segurança e de comunicação do projeto.';
  const body = normalizeText(payload?.body || 'Recomendamos a leitura da nova versão para entender como tratamos os dados de login e os comunicados enviados por e-mail.', 6_000) || 'Recomendamos a leitura da nova versão para entender como tratamos os dados de login e os comunicados enviados por e-mail.';
  const securityNote = normalizeText(payload?.securityNote || 'Se você tiver dúvidas sobre os novos termos, fale com nosso suporte oficial.', 220) || 'Se você tiver dúvidas sobre os novos termos, fale com nosso suporte oficial.';

  const textLines = [`Olá, ${name}!`, '', heading, '', intro, '', body, '', `WhatsApp do bot: ${ctaUrl}`, `Novos Termos de Serviço: ${termsUrl}`, '', 'Mensagem automática do OmniZap.'];

  return {
    subject,
    text: textLines.join('\n'),
    html: renderEmailLayout({
      payload,
      preheader: 'Atualizamos os Termos de Serviço do OmniZap.',
      heading,
      greeting: `Olá, ${name}!`,
      intro,
      body,
      ctaLabel,
      ctaUrl,
      ctaHint: botPhonePn ? `WhatsApp do bot: ${botPhonePn}` : '',
      secondaryCtaLabel: 'Ver novos Termos de Serviço',
      secondaryCtaUrl: termsUrl,
      securityNote,
      footerMessage: 'Comunicado oficial sobre atualização de termos.',
    }),
  };
};

const TEMPLATE_BUILDERS = {
  standard: buildStandardTemplate,
  default: buildStandardTemplate,
  welcome: buildWelcomeTemplate,
  magic_link: buildMagicLinkTemplate,
  password_reset_code: buildPasswordResetCodeTemplate,
  project_update: buildProjectUpdateTemplate,
  terms_update: buildTermsUpdateTemplate,
};

export const renderEmailTemplate = (templateKey, payload = {}) => {
  const normalizedTemplateKey = normalizeTemplateKey(templateKey);
  if (!normalizedTemplateKey) return null;
  const builder = TEMPLATE_BUILDERS[normalizedTemplateKey];
  if (typeof builder !== 'function') return null;

  const rendered = builder(payload || {});
  if (!rendered) return null;

  const subject = normalizeText(rendered.subject, 180);
  const text = normalizeText(rendered.text, 120_000);
  const html = normalizeText(rendered.html, 500_000);

  if (!subject || (!text && !html)) return null;

  return {
    subject,
    text: text || null,
    html: html || null,
    template_key: normalizedTemplateKey,
  };
};

export const listAvailableEmailTemplates = () => Object.keys(TEMPLATE_BUILDERS);
