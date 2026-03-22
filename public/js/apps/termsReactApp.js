import React from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);
const rootElement = document.getElementById('terms-react-root');

const DEFAULT_SUPPORT_WHATSAPP_NUMBER = '';
const DEFAULT_SUPPORT_WHATSAPP_URL = '#';
const DEFAULT_SUPPORT_WHATSAPP_DISPLAY = 'Canal oficial';
const DEFAULT_SUPPORT_LGPD_TEXT = 'Olá, gostaria de exercer meus direitos de titular de dados (LGPD).';

const normalizePhoneDigits = (value) =>
  String(value || '')
    .replace(/\D+/g, '')
    .slice(0, 15);

const formatWhatsappDisplay = (value) => {
  const digits = normalizePhoneDigits(value);
  if (!digits) return DEFAULT_SUPPORT_WHATSAPP_DISPLAY;
  if (digits.startsWith('55') && digits.length === 12) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  if (digits.startsWith('55') && digits.length === 13) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  return `+${digits}`;
};

const buildWhatsappUrl = (value, text = '') => {
  const digits = normalizePhoneDigits(value);
  if (!digits) return '';
  const normalizedText = String(text || '').trim();
  if (!normalizedText) return `https://wa.me/${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(normalizedText)}`;
};

const isValidWhatsappUrl = (value) => /^https?:\/\/wa\.me\/\d{8,15}(?:\?.*)?$/i.test(String(value || '').trim());

const resolveSupportLinks = (root) => {
  const dataset = root?.dataset || {};
  const supportNumber = normalizePhoneDigits(dataset.whatsappSupportNumber) || DEFAULT_SUPPORT_WHATSAPP_NUMBER;
  const rawSupportUrl = String(dataset.whatsappSupportUrl || '').trim();
  const rawSupportLgpdUrl = String(dataset.whatsappSupportLgpdUrl || '').trim();
  const rawSupportDisplay = String(dataset.whatsappSupportDisplay || '').trim();
  const supportUrl = (isValidWhatsappUrl(rawSupportUrl) ? rawSupportUrl : buildWhatsappUrl(supportNumber)) || DEFAULT_SUPPORT_WHATSAPP_URL;
  const supportLgpdUrl = (isValidWhatsappUrl(rawSupportLgpdUrl) ? rawSupportLgpdUrl : buildWhatsappUrl(supportNumber, DEFAULT_SUPPORT_LGPD_TEXT)) || supportUrl;
  const supportDisplay = rawSupportDisplay && !/__WHATSAPP_PUBLIC_CONTACT_/i.test(rawSupportDisplay) ? rawSupportDisplay : formatWhatsappDisplay(supportNumber);
  return {
    supportUrl,
    supportLgpdUrl,
    supportDisplay: supportDisplay || DEFAULT_SUPPORT_WHATSAPP_DISPLAY,
  };
};

const { supportUrl: SUPPORT_WHATSAPP_URL, supportLgpdUrl: SUPPORT_WHATSAPP_LGPD_URL, supportDisplay: SUPPORT_WHATSAPP_DISPLAY } = resolveSupportLinks(rootElement);

const TERMS_CONTENT_HTML = String.raw`
      <section class="terms-card" style="border-bottom: 4px solid hsla(142, 71%, 45%, 0.3)">
        <h1>Termos de Uso</h1>
        <span class="updated">Última atualização: 07/03/2026</span>
        <p>Este instrumento regula o acesso e uso do site, API, painel e funcionalidades de automação disponibilizadas pelo Omnizap.</p>
        <div class="flex flex-wrap gap-3 mt-6">
          <a class="contact-btn wa" href="${SUPPORT_WHATSAPP_URL}" target="_blank">WhatsApp Oficial</a>
          <a class="contact-btn ig" href="https://www.instagram.com/kaikybrofc/" target="_blank">Instagram</a>
        </div>
      </section>

      <section class="terms-card">
        <h2>1. Identificação do responsável</h2>
        <ul>
          <li>Responsável/Titular: <strong>Kaiky Brito Ribeiro</strong>.</li>
          <li>Nome empresarial: <strong>59.034.123 KAIKY BRITO RIBEIRO</strong>.</li>
          <li>CNPJ: <strong>59.034.123/0001-96</strong>.</li>
          <li>UF do registro: <strong>RR</strong>.</li>
          <li>Canal de contato principal: <a href="${SUPPORT_WHATSAPP_URL}" target="_blank" class="accent">${SUPPORT_WHATSAPP_URL}</a>.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>2. Aceitação, vigência e capacidade civil</h2>
        <ul>
          <li>O uso da plataforma caracteriza aceite eletrônico, livre e informado destes Termos.</li>
          <li>O usuário declara possuir capacidade civil para contratar ou, quando aplicável, estar assistido/representado por responsável legal.</li>
          <li>Se o usuário atuar em nome de pessoa jurídica, declara possuir poderes para vincular a organização a este instrumento.</li>
          <li>Estes Termos permanecem vigentes enquanto houver uso da plataforma ou obrigações legais/contratuais pendentes.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>3. Definições contratuais</h2>
        <ul>
          <li><strong>Plataforma:</strong> ambiente digital Omnizap (site, API, integrações e painel).</li>
          <li><strong>Serviço oficial:</strong> operação hospedada e controlada pelos canais oficiais do Omnizap (incluindo domínio omnizap.shop e endpoints oficiais).</li>
          <li><strong>Instância derivada/self-host:</strong> fork, redistribuição ou implantação independente feita por terceiro a partir do código-fonte open source.</li>
          <li><strong>Usuário:</strong> pessoa natural ou jurídica que acessa ou utiliza a plataforma.</li>
          <li><strong>Conta:</strong> credencial de acesso vinculada a usuário, e-mail e/ou identificadores técnicos.</li>
          <li><strong>Dados pessoais:</strong> informações relacionadas a pessoa natural identificada ou identificável, nos termos da LGPD.</li>
          <li><strong>Operador:</strong> terceiro que trata dados em nome do controlador, conforme art. 5º, VII, da LGPD.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>4. Objeto e escopo de uso</h2>
        <ul>
          <li>Estes Termos se aplicam ao uso do serviço oficial do Omnizap (site, API, painel administrativo e módulos de automação operados pelos canais oficiais).</li>
          <li>Forks, redistribuições e instâncias auto-hospedadas por terceiros não se vinculam automaticamente a estes Termos.</li>
          <li>Em instância derivada/self-host, o operador dessa instância é responsável por publicar seus próprios termos, política de privacidade e instrumentos de conformidade.</li>
          <li>A plataforma possui finalidade técnica e educacional, sem prejuízo de usos operacionais legítimos pelo usuário.</li>
          <li>O usuário é integralmente responsável pela regularidade jurídica do uso que fizer do sistema em seu contexto de negócio.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>5. Cadastro, autenticação e segurança da conta</h2>
        <ul>
          <li>O usuário deve fornecer dados verdadeiros, atualizados e completos para cadastro e manutenção da conta.</li>
          <li>Credenciais, tokens e sessões são pessoais e intransferíveis, cabendo ao usuário o dever de guarda e sigilo.</li>
          <li>O responsável pela conta responde pelas ações realizadas com suas credenciais, ressalvadas hipóteses de falha de segurança comprovadamente atribuível à plataforma ou fraude sem culpa do usuário.</li>
          <li>Podem ser aplicadas medidas adicionais de verificação de identidade em hipóteses de risco, fraude, abuso ou exigência legal.</li>
        </ul>
        <h3>5.1 Redefinição de senha e controles antiabuso</h3>
        <ul>
          <li>Fluxos de recuperação de acesso podem exigir e-mail válido, token temporário, expiração automática e uso único do link.</li>
          <li>Podem ser aplicados limite de tentativas, janela mínima entre solicitações e bloqueio temporário por comportamento suspeito.</li>
          <li>Eventos críticos de segurança podem ser registrados para trilha de auditoria e prevenção de incidentes.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>6. Uso permitido e condutas proibidas</h2>
        <ul>
          <li>É permitido utilizar a plataforma para automação e integração, desde que observadas a legislação aplicável e as políticas de terceiros integrados.</li>
          <li>É vedado o uso para spam, fraude, phishing, engenharia social, assédio, malware, invasão de sistemas ou qualquer prática ilícita.</li>
          <li>É vedado burlar controles técnicos, limitações comerciais, políticas de uso ou termos de plataformas terceiras (incluindo provedores de mensageria) no contexto do serviço oficial, por mascaramento indevido de origem ou automações não autorizadas.</li>
          <li>Esta vedação não restringe, por si só, os direitos de uso, estudo, modificação e redistribuição do código-fonte licenciado sob MIT fora da operação oficial, desde que observadas a legislação aplicável e as licenças de terceiros.</li>
          <li>É vedada a coleta, o tratamento ou o compartilhamento de dados de terceiros sem base legal adequada.</li>
          <li>É vedado o uso para monitoramento clandestino de comunicações sem ciência dos envolvidos ou sem base legal aplicável.</li>
          <li>É vedado testar vulnerabilidades, realizar varreduras agressivas ou provocar degradação de serviço sem autorização formal prévia.</li>
          <li>O usuário responderá civil, administrativa e criminalmente por conteúdo e operações executadas por sua conta.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>7. Tratamento de dados e fundamentos jurídicos</h2>
        <p>O tratamento de dados pessoais poderá ocorrer, conforme o caso concreto, com fundamento nas bases legais do art. 7º da LGPD, incluindo:</p>
        <ul>
          <li>execução de contrato e de procedimentos preliminares relacionados à contratação;</li>
          <li>cumprimento de obrigação legal ou regulatória;</li>
          <li>exercício regular de direitos em processo judicial, administrativo ou arbitral;</li>
          <li>legítimo interesse do controlador, observados direitos e liberdades fundamentais do titular;</li>
          <li>consentimento, quando exigido pela legislação aplicável.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2 id="politica-de-privacidade">8. Política de Privacidade (resumo contratual)</h2>
        <p>Esta cláusula é complementar. A versão principal e separada está em <a href="/politica-de-privacidade/" class="accent">/politica-de-privacidade/</a>.</p>
        <ul>
          <li><strong>Finalidade:</strong> dados são tratados para operação da plataforma, autenticação, segurança, suporte e evolução técnica do serviço.</li>
          <li><strong>Necessidade:</strong> coleta limitada ao mínimo necessário para execução das funcionalidades contratadas/ativadas.</li>
          <li><strong>Transparência:</strong> este documento descreve categorias de dados, finalidades e hipóteses de compartilhamento.</li>
          <li><strong>Qualidade dos dados:</strong> o titular poderá solicitar correções de dados incompletos, inexatos ou desatualizados.</li>
          <li><strong>Segurança:</strong> são adotadas medidas técnicas e administrativas razoáveis para redução de risco de acesso indevido ou vazamento.</li>
          <li><strong>Governança:</strong> são observados controles de minimização, retenção por prazo, controle de acesso por perfil e registro de acesso a conteúdo sensível, quando tecnicamente aplicável.</li>
          <li><strong>Não comercialização:</strong> dados pessoais não são comercializados como produto.</li>
        </ul>
        <h3>8.1 Coleta integral de mensagens (quando habilitada)</h3>
        <p>Para execução de funcionalidades de automação, suporte técnico, auditoria, segurança e prevenção de abuso, a plataforma poderá coletar e tratar mensagens de forma integral no contexto conectado pelo usuário.</p>
        <ul>
          <li>Podem ser tratados conteúdo textual, áudios, imagens, vídeos, documentos, links e metadados técnicos relacionados às mensagens.</li>
          <li>Em ambientes de grupo/comunidade, o usuário que adiciona e opera o bot declara ser responsável por informar participantes e garantir base legal adequada para o tratamento.</li>
          <li>Quando exigido pela legislação aplicável, o usuário deverá obter consentimento válido ou adotar outra hipótese legal legítima antes da coleta.</li>
          <li>Dados podem ser usados para evidências de segurança, mitigação de fraude, investigação de abuso e exercício regular de direitos.</li>
        </ul>
        <h3>8.2 Compromisso de sigilo e confidencialidade</h3>
        <ul>
          <li>O Omnizap compromete-se a observar o sigilo e a confidencialidade das informações tratadas, nos limites legais e técnicos aplicáveis.</li>
          <li>O acesso interno ao conteúdo é restrito por necessidade operacional (need-to-know), com controles de acesso e trilha de auditoria.</li>
          <li>Operadores e fornecedores contratados para apoiar o serviço devem observar obrigações contratuais de confidencialidade e proteção de dados.</li>
          <li>A divulgação de conteúdo a terceiros somente ocorrerá mediante obrigação legal, ordem judicial/requisição válida de autoridade competente ou autorização do usuário, quando cabível.</li>
        </ul>
        <h3>8.3 Dever de sigilo profissional e penalidade contratual</h3>
        <ul>
          <li>O usuário, seus prepostos, colaboradores e terceiros por ele autorizados assumem dever de sigilo profissional sobre dados, mensagens, credenciais e informações confidenciais acessadas por meio da plataforma.</li>
          <li>É vedada a divulgação, cópia, compartilhamento, comercialização, publicação ou uso para finalidade diversa daquela legitimamente autorizada.</li>
          <li>A violação comprovada do dever de sigilo, por ação ou omissão, poderá sujeitar o infrator ao pagamento de multa contratual de <strong>até R$ 10.000,00 (dez mil reais) por incidente comprovado</strong>, graduada por gravidade, extensão do dano e cooperação na mitigação, sem prejuízo de perdas e danos e medidas legais cabíveis.</li>
          <li>Em relações de consumo, a aplicação de multa e indenização observará proporcionalidade, boa-fé objetiva, normas de ordem pública e direitos inderrogáveis do consumidor.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>9. Direitos do titular (LGPD)</h2>
        <p>Nos termos do art. 18 da Lei nº 13.709/2018 (LGPD), o titular poderá requerer, quando cabível:</p>
        <ul>
          <li>confirmação da existência de tratamento e acesso aos dados;</li>
          <li>correção de dados incompletos, inexatos ou desatualizados;</li>
          <li>anonimização, bloqueio ou eliminação de dados desnecessários, excessivos ou tratados em desconformidade;</li>
          <li>portabilidade, eliminação de dados tratados com consentimento e informação sobre compartilhamentos;</li>
          <li>revogação do consentimento e oposição ao tratamento, observados os limites legais;</li>
          <li>peticionar perante a ANPD e demais autoridades competentes, nos termos da lei.</li>
        </ul>
        <p>Quando aplicável, o atendimento observará resposta simplificada imediata e declaração clara/completa em até 15 (quinze) dias, conforme LGPD art. 19.</p>
        <p>Para exercício de direitos e demandas de privacidade:</p>
        <div class="flex flex-wrap gap-3 mt-4">
          <a class="contact-btn wa" href="${SUPPORT_WHATSAPP_LGPD_URL}" target="_blank">Solicitar via WhatsApp</a>
          <a class="contact-btn ig" href="https://www.instagram.com/kaikybrofc/" target="_blank">Contato no Instagram</a>
        </div>
      </section>

      <section class="terms-card">
        <h2>10. Compartilhamento, operadores e transferência internacional</h2>
        <ul>
          <li>Poderá haver compartilhamento com operadores e fornecedores de infraestrutura, monitoramento, autenticação, comunicação e suporte.</li>
          <li>Compartilhamentos com terceiros ocorrerão no limite necessário para execução das finalidades legítimas da plataforma.</li>
          <li>Operadores que tratem conteúdo de mensagens deverão observar dever de confidencialidade, segurança da informação e uso restrito à finalidade contratada.</li>
          <li>Dados poderão ser fornecidos a autoridades públicas mediante obrigação legal, ordem judicial ou requisição válida.</li>
          <li>Em transferências internacionais, serão adotados mecanismos compatíveis com a LGPD e regulamentação da ANPD, incluindo cláusulas contratuais e medidas técnicas de segurança.</li>
          <li>O inventário público de suboperadores em <a href="/suboperadores/" class="accent">/suboperadores/</a> descreve categorias, escopo de dados, região de processamento e status de atualização.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>11. Retenção, registros e evidências digitais</h2>
        <ul>
          <li>Dados e logs podem ser armazenados pelo período necessário para cumprimento de finalidades contratuais, segurança e obrigações legais.</li>
          <li>Quando tecnicamente viável, registros de acesso a mensagens poderão conter identificador do agente, data/hora, tipo de operação e justificativa operacional.</li>
          <li>Quando aplicável ao modelo operacional da plataforma, registros de acesso a aplicações poderão ser mantidos nos termos do Marco Civil da Internet.</li>
          <li>Backups e registros de auditoria podem subsistir por prazo adicional para continuidade, recuperação e integridade probatória.</li>
          <li>Após o término da finalidade, os dados poderão ser eliminados, bloqueados ou anonimizados, ressalvadas hipóteses legais de retenção.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>12. Segurança da informação e resposta a incidentes</h2>
        <ul>
          <li>São adotadas práticas de hardening, controle de acesso, limitação de taxa, segregação de ambientes e monitoramento de eventos críticos.</li>
          <li>São adotadas salvaguardas de criptografia em trânsito e, quando aplicável ao cenário técnico, em repouso para dados e backups sensíveis.</li>
          <li>Nenhum ambiente computacional é integralmente imune a falhas; por isso, não há garantia de invulnerabilidade absoluta.</li>
          <li>Na hipótese de incidente relevante envolvendo dados pessoais, serão adotadas as medidas técnicas, administrativas e legais cabíveis.</li>
          <li>O plano formal de resposta a incidentes poderá incluir comitê de crise, análise de impacto, preservação de evidências e gatilho para comunicação à ANPD e aos titulares, quando exigido pela legislação aplicável.</li>
          <li>Quando exigido em lei, serão realizadas comunicações às autoridades competentes e aos titulares afetados.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>13. Propriedade intelectual e conteúdo de terceiros</h2>
        <ul>
          <li>O usuário declara possuir direitos, licenças e autorizações necessárias sobre os conteúdos submetidos à plataforma.</li>
          <li>Conteúdo que infrinja direitos autorais, marca, imagem, privacidade ou legislação poderá ser removido, sem aviso prévio, para mitigação de risco jurídico.</li>
          <li>O software, documentação, layout, sinais distintivos e demais ativos do Omnizap permanecem protegidos pela legislação aplicável, sem prejuízo dos direitos concedidos pela licença MIT sobre o código-fonte publicado no repositório oficial.</li>
          <li>Pedidos de remoção por violação de direitos poderão ser enviados aos canais oficiais, com documentação mínima comprobatória.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>14. API, disponibilidade e alterações técnicas</h2>
        <ul>
          <li>A API e demais recursos podem sofrer evolução, descontinuidade, limitação de uso, versionamento e janelas de manutenção.</li>
          <li>Não se garante disponibilidade contínua, latência mínima, compatibilidade irrestrita com terceiros ou ausência completa de falhas.</li>
          <li>Integrações com serviços de terceiros dependem de condições externas e podem ser alteradas sem controle direto da plataforma.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>15. Suspensão, bloqueio cautelar e encerramento</h2>
        <ul>
          <li>Poderá ocorrer suspensão ou bloqueio cautelar em caso de indício de abuso, fraude, violação de segurança, risco regulatório ou ordem de autoridade competente.</li>
          <li>O acesso poderá ser encerrado em caso de descumprimento contratual, uso ilícito, inobservância de políticas técnicas ou determinação legal.</li>
          <li>O usuário poderá encerrar o uso a qualquer momento, observadas obrigações pendentes e retenções legalmente obrigatórias.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>16. Responsabilidade do usuário e indenização regressiva</h2>
        <ul>
          <li>O usuário compromete-se a indenizar regressivamente o Omnizap por danos, custos e despesas decorrentes de uso ilícito ou violação destes Termos.</li>
          <li>Incluem-se, quando aplicável, custos de defesa, perícia, cumprimento de ordem judicial e sanções atribuíveis à conduta do usuário.</li>
          <li>Esta cláusula não afasta direitos inderrogáveis previstos em lei.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>17. Limitação de responsabilidade</h2>
        <p>Na extensão máxima permitida pela legislação aplicável, o Omnizap não será responsável por danos indiretos, lucros cessantes, perdas de oportunidade, indisponibilidade de terceiros, bloqueios externos de conta, força maior, caso fortuito, atos de terceiros ou uso indevido da plataforma pelo usuário.</p>
        <p class="note"><strong>Nota:</strong> nada neste instrumento regula responsabilidade nos casos em que a legislação brasileira expressamente proíba limitação ou exclusão.</p>
      </section>

      <section class="terms-card">
        <h2>18. Comunicações, notificações e validade eletrônica</h2>
        <ul>
          <li>Comunicações operacionais e de segurança podem ser realizadas por e-mail, painéis internos, avisos no site e canais oficiais de atendimento.</li>
          <li>O usuário reconhece validade jurídica de registros eletrônicos, logs, comprovantes de envio e trilhas de auditoria como meios de prova.</li>
          <li>Notificações devem conter identificação mínima do solicitante e descrição objetiva da demanda para tratamento adequado.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>19. Alterações destes Termos</h2>
        <p>Estes Termos poderão ser atualizados para refletir mudanças legais, regulatórias, jurisprudenciais, técnicas ou operacionais. Em alterações materiais, será publicado aviso com antecedência razoável e registro de versão/data nesta página. A continuidade de uso após vigência da nova versão caracteriza novo aceite, sem prejuízo dos direitos legais do usuário.</p>
      </section>

      <section class="terms-card">
        <h2>20. Contato e foro</h2>
        <p>Para questões contratuais, privacidade e proteção de dados, utilize os canais oficiais abaixo.</p>
        <div class="flex flex-wrap gap-3 mt-4">
          <a class="contact-btn wa" href="${SUPPORT_WHATSAPP_URL}" target="_blank">WhatsApp oficial</a>
          <a class="contact-btn ig" href="https://www.instagram.com/kaikybrofc/" target="_blank">Instagram oficial</a>
        </div>
        <ul class="mt-6">
          <li>WhatsApp oficial: <strong>${SUPPORT_WHATSAPP_DISPLAY}</strong>.</li>
          <li>Link direto: <a href="${SUPPORT_WHATSAPP_URL}" target="_blank" class="accent">${SUPPORT_WHATSAPP_URL}</a>.</li>
          <li>Instagram oficial: <a href="https://www.instagram.com/kaikybrofc/" target="_blank" class="accent">https://www.instagram.com/kaikybrofc/</a>.</li>
          <li>Contato complementar para notificações formais: privacidade@omnizap.shop.</li>
          <li>Encarregado (LGPD art. 41): Kaiky Brito Ribeiro, contato pelo canal oficial de privacidade.</li>
          <li>Para relações empresariais (B2B), fica eleito o foro da Comarca de Boa Vista/RR, ressalvadas hipóteses legais de competência absoluta. Em relações de consumo, prevalece o foro do domicílio do consumidor quando a legislação assim determinar.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>21. Referências legais oficiais (Brasil)</h2>
        <ul>
          <li>Constituição Federal de 1988 (direitos e garantias fundamentais): <a href="https://www.planalto.gov.br/ccivil_03/constituicao/constituicao.htm" target="_blank" class="accent">Planalto</a>.</li>
          <li>Lei nº 13.709/2018 (Lei Geral de Proteção de Dados Pessoais - LGPD): <a href="https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm" target="_blank" class="accent">Planalto</a>.</li>
          <li>Lei nº 12.965/2014 (Marco Civil da Internet): <a href="https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2014/lei/l12965.htm" target="_blank" class="accent">Planalto</a>.</li>
          <li>Decreto nº 8.771/2016 (regulamenta o Marco Civil da Internet): <a href="https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2016/decreto/d8771.htm" target="_blank" class="accent">Planalto</a>.</li>
          <li>Lei nº 8.078/1990 (Código de Defesa do Consumidor): <a href="https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm" target="_blank" class="accent">Planalto</a>.</li>
          <li>Lei nº 10.406/2002 (Código Civil): <a href="https://www.planalto.gov.br/ccivil_03/leis/2002/l10406compilada.htm" target="_blank" class="accent">Planalto</a>.</li>
          <li>Lei nº 9.610/1998 (Direitos Autorais): <a href="https://www.planalto.gov.br/ccivil_03/leis/l9610.htm" target="_blank" class="accent">Planalto</a>.</li>
          <li>Lei nº 9.609/1998 (Lei de Software): <a href="https://www.planalto.gov.br/ccivil_03/leis/l9609.htm" target="_blank" class="accent">Planalto</a>.</li>
          <li>ANPD - direitos do titular e canais institucionais: <a href="https://www.gov.br/anpd/pt-br" target="_blank" class="accent">gov.br/anpd</a>.</li>
          <li>ANPD - comunicação de incidente de segurança (CIS): <a href="https://www.gov.br/anpd/pt-br/canais_atendimento/agente-de-tratamento/comunicado-de-incidente-de-seguranca-cis" target="_blank" class="accent">gov.br/anpd/cis</a>.</li>
          <li>Resolução CD/ANPD nº 15/2024 (comunicação de incidente): <a href="https://dspace.mj.gov.br/handle/1/12879" target="_blank" class="accent">dspace.mj.gov.br/handle/1/12879</a>.</li>
          <li>Resolução CD/ANPD nº 18/2024 (encarregado): <a href="https://dspace.mj.gov.br/handle/1/13151" target="_blank" class="accent">dspace.mj.gov.br/handle/1/13151</a>.</li>
          <li>Resolução CD/ANPD nº 19/2024 (transferência internacional): <a href="https://dspace.mj.gov.br/handle/1/13458" target="_blank" class="accent">dspace.mj.gov.br/handle/1/13458</a>.</li>
          <li>Resolução CD/ANPD nº 32/2026 (adequação da União Europeia): <a href="https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd" target="_blank" class="accent">gov.br/anpd/regulamentacoes_anpd</a>.</li>
          <li>WhatsApp Business Terms: <a href="https://www.whatsapp.com/legal/business-terms/" target="_blank" class="accent">whatsapp.com/legal/business-terms</a>.</li>
          <li>WhatsApp Business Messaging Policy: <a href="https://business.whatsapp.com/policy" target="_blank" class="accent">business.whatsapp.com/policy</a>.</li>
          <li>WhatsApp Brand Guidelines: <a href="https://about.meta.com/brand/resources/whatsapp/whatsapp-brand/" target="_blank" class="accent">about.meta.com/brand/resources</a>.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>22. Disposições gerais</h2>
        <ul>
          <li>A eventual tolerância quanto ao descumprimento de obrigação não importará novação, renúncia de direito ou alteração contratual tácita.</li>
          <li>A nulidade ou inexequibilidade de cláusula específica não invalidará as demais disposições, que permanecerão em pleno vigor.</li>
          <li>Este instrumento representa o acordo integral entre as partes sobre seu objeto, prevalecendo sobre entendimentos anteriores conflitantes.</li>
          <li>Os títulos das cláusulas possuem finalidade apenas organizacional e não restringem a interpretação do conteúdo jurídico.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>23. Cláusulas adicionais de proteção jurídica</h2>
        <h3>23.1 Papéis LGPD entre as partes</h3>
        <ul>
          <li>Conforme o fluxo operacional, o Omnizap poderá atuar como controlador ou operador de dados pessoais, nos termos da LGPD.</li>
          <li>Quando o tratamento decorrer de instruções do cliente/usuário, este permanecerá responsável pela legalidade da instrução e pela definição de finalidade.</li>
        </ul>
        <h3>23.2 Declaração de base legal pelo usuário/cliente</h3>
        <ul>
          <li>Ao ativar integrações e automações, o usuário declara possuir base legal válida para tratamento dos dados e mensagens envolvidas.</li>
          <li>A ausência de base legal caracteriza infração contratual grave, sem prejuízo das medidas legais cabíveis.</li>
        </ul>
        <h3>23.3 Transparência com participantes e terceiros</h3>
        <ul>
          <li>O usuário compromete-se a informar participantes dos grupos/comunidades sobre a atuação do bot e sobre o tratamento de mensagens.</li>
          <li>Quando exigido por lei, deverá manter aviso de privacidade acessível e atualizado no contexto de uso.</li>
        </ul>
        <h3>23.4 Cooperação obrigatória em incidentes</h3>
        <ul>
          <li>Na hipótese de incidente de segurança, o usuário deverá cooperar com investigação, contenção e mitigação, fornecendo informações técnicas úteis em prazo razoável.</li>
          <li>A omissão injustificada poderá ensejar suspensão cautelar de acesso.</li>
        </ul>
        <h3>23.5 Retenção e descarte com parâmetros objetivos</h3>
        <ul>
          <li>Mensagens tratadas: retenção conforme finalidade operacional e base legal do tratamento.</li>
          <li>Logs técnicos e trilhas de auditoria: retenção pelo prazo necessário a segurança, prova e cumprimento legal.</li>
          <li>Backups: retenção cíclica por janela técnica definida em política interna de continuidade.</li>
        </ul>
        <h3>23.6 Limite global de responsabilidade financeira</h3>
        <ul>
          <li>Ressalvadas hipóteses de dolo, violação de sigilo, danos morais, danos à personalidade e demais limites legais inderrogáveis, a responsabilidade total do Omnizap, por evento ou série de eventos relacionados, fica limitada ao montante efetivamente pago pelo usuário nos 12 (doze) meses anteriores ao fato gerador.</li>
        </ul>
        <h3>23.7 Cláusula penal calibrada e revisão judicial</h3>
        <ul>
          <li>As multas contratuais previstas neste instrumento possuem natureza não compensatória e não afastam perdas e danos adicionais quando cabíveis.</li>
          <li>Sem prejuízo da exigibilidade, o valor poderá ser revisto judicialmente nas hipóteses legalmente previstas.</li>
        </ul>
        <h3>23.8 Suspensão imediata por risco jurídico ou técnico</h3>
        <ul>
          <li>O Omnizap poderá suspender imediatamente contas, tokens, integrações ou endpoints em caso de risco iminente à segurança, fraude, abuso, decisão de autoridade ou potencial dano relevante a terceiros.</li>
        </ul>
        <h3>23.9 Procedimento de notice-and-takedown</h3>
        <ul>
          <li>Denúncias de conteúdo ilícito, violação autoral, violação de privacidade ou uso indevido poderão resultar em remoção preventiva, bloqueio cautelar e preservação de evidências para apuração.</li>
          <li>Quando houver evidência inicial mínima, a triagem ocorrerá em até 24 (vinte e quatro) horas e a decisão cautelar inicial em até 72 (setenta e duas) horas, ressalvados casos tecnicamente complexos ou de força maior.</li>
        </ul>
        <h3>23.10 Prova eletrônica e integridade de registros</h3>
        <ul>
          <li>Logs, carimbos de data/hora, identificadores técnicos, trilhas de auditoria e registros de API poderão ser utilizados como elementos probatórios em processos judiciais ou administrativos, observada a legislação aplicável.</li>
        </ul>
        <h3>23.11 Ordem de prevalência documental</h3>
        <ul>
          <li>Em caso de conflito interpretativo, prevalecerá a seguinte ordem: (i) instrumento contratual específico assinado entre as partes, (ii) aditivo de proteção de dados (quando houver), (iii) estes Termos de Uso, (iv) política complementar de privacidade e documentos operacionais públicos.</li>
        </ul>
        <h3>23.12 Não renúncia, separabilidade e cessão</h3>
        <ul>
          <li>A não exigência imediata de direito contratual não implicará renúncia.</li>
          <li>Se qualquer cláusula for considerada inválida, as demais permanecerão eficazes.</li>
          <li>É vedada a cessão de posição contratual pelo usuário sem anuência prévia e expressa do Omnizap, ressalvadas hipóteses legais obrigatórias.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>24. Programa reforçado de conformidade e governança</h2>
        <p>As obrigações desta seção se aplicam à operação do serviço oficial. Operadores de instâncias derivadas/self-host devem implementar governança equivalente sob sua própria responsabilidade jurídica.</p>
        <h3>24.1 Política de conteúdo e categorias reguladas</h3>
        <ul>
          <li>O usuário declara que somente utilizará a plataforma em atividades permitidas por lei e por políticas das plataformas integradas.</li>
          <li>Em verticais reguladas (ex.: saúde, crédito, apostas, criptoativos, educação, publicidade para menores ou outras de risco regulatório), o usuário deverá manter licenças, autorizações e avisos legais exigidos para o país, estado e município de atuação.</li>
          <li>O usuário deve observar classificação etária aplicável, restrições de faixa etária e limitações territoriais/jurisdicionais para oferta de produtos e serviços.</li>
        </ul>
        <h3>24.2 Branding e uso de marcas de terceiros</h3>
        <ul>
          <li>É vedado apresentar o Omnizap como serviço oficial, parceiro certificado, afiliado ou endossado pela Meta/WhatsApp sem autorização formal e verificável.</li>
          <li>É vedado utilizar logotipos, nomes comerciais, ícones ou identidade visual de terceiros fora das diretrizes oficiais de marca e sem o licenciamento pertinente.</li>
          <li>Quando houver referência nominativa a marcas de terceiros, ela deverá ser estritamente descritiva, sem sugerir patrocínio, apoio institucional ou vínculo societário inexistente.</li>
        </ul>
        <h3>24.3 Contratação corporativa, DPA e alocação de risco</h3>
        <ul>
          <li>Para operação corporativa em escala do serviço oficial, o Omnizap poderá exigir contrato específico com cláusulas de proteção de dados, incluindo DPA (Data Processing Addendum).</li>
          <li>O contrato poderá prever garantias expressas de base legal, dever de cooperação regulatória, indenização regressiva e limitação de responsabilidade em parâmetros economicamente proporcionais.</li>
          <li>A recusa em firmar os instrumentos jurídicos mínimos poderá ensejar suspensão de funcionalidades de alto risco até regularização contratual.</li>
        </ul>
        <h3>24.4 Governança de dados e sigilo de mensagens</h3>
        <ul>
          <li>O tratamento observará princípios de minimização, necessidade, limitação de finalidade e retenção por prazo definido em política interna.</li>
          <li>Serão adotadas medidas de proteção como criptografia em trânsito, controle de acesso por privilégio mínimo, segregação de funções e trilhas de auditoria.</li>
          <li>O acesso a conteúdo integral de mensagens deverá ocorrer com justificativa operacional legítima, registro de evidência e controle de responsabilidade.</li>
        </ul>
        <h3>24.5 Plano formal de incidentes e gatilho ANPD/titulares</h3>
        <ul>
          <li>O Omnizap manterá plano formal de resposta a incidentes com etapas de detecção, contenção, erradicação, recuperação e lições aprendidas.</li>
          <li>Quando houver incidente com risco ou dano relevante aos titulares, será acionado fluxo formal de comunicação à ANPD e aos titulares potencialmente afetados, nos termos da legislação vigente.</li>
          <li>Quando aplicável ao controlador, a comunicação regulatória observará os prazos legais vigentes, incluindo o prazo de 3 (três) dias úteis previsto no regulamento da ANPD, ressalvada legislação específica superveniente.</li>
          <li>As comunicações incluirão, quando exigido, descrição do incidente, dados afetados, medidas técnicas/administrativas adotadas, riscos envolvidos, justificativa para eventual atraso e medidas para mitigar efeitos.</li>
        </ul>
        <h3>24.6 Separação patrimonial e seguro de riscos cibernéticos</h3>
        <ul>
          <li>A operação do serviço será estruturada por pessoa jurídica, com segregação patrimonial e contábil em relação à pessoa física dos sócios/administradores, conforme legislação aplicável.</li>
          <li>Poderão ser contratadas coberturas de seguro cibernético e/ou Errors and Omissions (E&O), sem prejuízo das limitações contratuais de responsabilidade.</li>
        </ul>
        <h3>24.7 Canal de notice-and-takedown com SLA</h3>
        <ul>
          <li>Fica instituído canal de notificação para denúncias de conteúdo ilícito, uso irregular, violação de direitos autorais, marca, imagem ou privacidade.</li>
          <li>As notificações deverão conter identificação mínima do notificante, URL/ID do conteúdo, fundamento jurídico e elemento probatório mínimo para triagem.</li>
          <li>A confirmação de recebimento ocorrerá, preferencialmente, em até 24 (vinte e quatro) horas úteis, com medidas cautelares conforme nível de risco.</li>
        </ul>
        <h3>24.8 Comitê mensal de compliance</h3>
        <ul>
          <li>Na operação oficial, será mantido comitê mensal de compliance com representantes de jurídico, produto e segurança da informação, com ata e plano de ação.</li>
          <li>O comitê revisará aderência regulatória, termos de terceiros, incidentes, métricas de segurança, solicitações de takedown e pendências contratuais.</li>
        </ul>
      </section>

      <section class="terms-card">
        <h2>25. Histórico de alterações</h2>
        <ul>
          <li><strong>07/03/2026:</strong> revisão jurídica complementar com reforço de direitos do titular (incluindo prazo do art. 19), transparência de transferência internacional (Res. 19/2024), encarregado (Res. 18/2024), ajustes de foro para relações de consumo, critérios de proporcionalidade em cláusula penal, detalhamento da comunicação de incidentes (Res. 15/2024) e delimitação expressa entre serviço oficial e instâncias derivadas/self-host do projeto open source.</li>
          <li><strong>06/03/2026:</strong> inclusão de cláusulas sobre autenticação por senha, redefinição por e-mail com controles antiabuso, filosofia open source, comunidade e reforço das diretrizes de segurança de dados.</li>
          <li><strong>05/03/2026:</strong> inclusão de cláusula sobre uso do e-mail de login para envio de informações do projeto, comunicados operacionais e avisos de segurança.</li>
          <li><strong>28/02/2026:</strong> inclusão de contatos explícitos, aviso de projeto não oficial, termos complementares de privacidade, exemplos práticos de uso proibido e linguagem simplificada em seções jurídicas.</li>
          <li><strong>26/02/2026:</strong> publicação da versão inicial dos termos.</li>
        </ul>
      </section>
`;

const TermsReactApp = () => html`
  <div className="min-h-screen flex flex-col">
    <!-- Navbar -->
    <header className="sticky top-0 z-50 border-b border-base-200 bg-base-100/80 backdrop-blur-xl">
      <div className="container mx-auto px-4">
        <div className="flex h-16 items-center justify-between gap-4">
          <div className="flex-1">
            <a href="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
              <img src="/assets/images/brand-logo-128.webp" className="w-8 h-8 rounded-xl shadow-sm" alt="Logo" />
              <span className="text-base sm:text-lg font-black tracking-tight">OmniZap<span className="text-primary">.</span></span>
            </a>
          </div>

          <nav className="hidden lg:flex items-center gap-4">
            <a href="/" className="text-sm font-bold opacity-60 hover:opacity-100 transition-opacity">Início</a>
            <a href="/stickers/" className="text-sm font-bold opacity-60 hover:opacity-100 transition-opacity">Marketplace</a>
            <a href="/politica-de-privacidade/" className="text-sm font-bold opacity-60 hover:opacity-100 transition-opacity">Privacidade</a>
          </nav>

          <div className="flex items-center gap-3">
            <a href="/login/" className="btn btn-primary btn-sm h-9 min-h-0 rounded-xl font-bold px-4"> Entrar </a>
          </div>
        </div>
      </div>
    </header>

    <main className="terms-container">
      <div dangerouslySetInnerHTML=${{ __html: TERMS_CONTENT_HTML }}></div>
    </main>

    <footer className="py-12 border-t border-base-200 mt-auto text-center">
      <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-base-content/20">© 2026 OMNIZAP · TERMS OF SERVICE V2</p>
    </footer>
  </div>
`;

const useHashAnchorSync = () => {
  React.useEffect(() => {
    const scrollToAnchor = () => {
      const rawHash = String(window.location.hash || '')
        .replace(/^#/, '')
        .trim();
      if (!rawHash) return;
      const targetId = decodeURIComponent(rawHash);
      const target = document.getElementById(targetId);
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start' });
      }
    };

    scrollToAnchor();
    window.addEventListener('hashchange', scrollToAnchor);
    return () => window.removeEventListener('hashchange', scrollToAnchor);
  }, []);
};

const useRevealEffect = () => {
  React.useEffect(() => {
    const observer =
      typeof globalThis.IntersectionObserver === 'function'
        ? new globalThis.IntersectionObserver(
            (entries) => {
              entries.forEach((entry) => {
                if (entry.isIntersecting) {
                  entry.target.classList.add('is-visible');
                  observer.unobserve(entry.target);
                }
              });
            },
            { threshold: 0.1 },
          )
        : null;

    document.querySelectorAll('.terms-card').forEach((el, i) => {
      el.setAttribute('data-reveal', 'fade-up');
      el.style.setProperty('--reveal-delay', `${Math.min(i * 60, 400)}ms`);
      if (observer) {
        observer.observe(el);
      } else {
        el.classList.add('is-visible');
      }
    });

    return () => {
      if (observer) observer.disconnect();
    };
  }, []);
};

const TermsReactAppWithEffects = () => {
  useHashAnchorSync();
  useRevealEffect();
  return html`<${TermsReactApp} />`;
};

if (rootElement) {
  const root = createRoot(rootElement);
  root.render(html`<${TermsReactAppWithEffects} />`);
}
