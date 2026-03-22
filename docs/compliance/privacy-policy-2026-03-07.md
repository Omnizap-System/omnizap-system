# Política de Privacidade (Documento Separado dos Termos)

Data da versão: 2026-03-07  
Escopo: site, login web, painel, API e operação de automação do Omnizap.

## 0) Escopo desta política (serviço oficial)

- Esta política se aplica ao serviço oficial operado pelos canais do Omnizap (incluindo domínio omnizap.shop e endpoints oficiais).
- Forks, redistribuições e instâncias auto-hospedadas por terceiros não se vinculam automaticamente a este documento.
- Em instância derivada/self-host, o operador da instância atua como controlador independente e deve publicar sua própria política de privacidade.

## 1) Controlador e contato

- Controlador: 59.034.123 KAIKY BRITO RIBEIRO (CNPJ 59.034.123/0001-96).
- Contato de privacidade: `https://wa.me/<WHATSAPP_PUBLIC_CONTACT_NUMBER>`
- Canal para titulares (LGPD): mensagem com assunto "DSAR LGPD" no contato oficial.
- Para serviços de terceiros baseados em fork/self-host, o contato de privacidade deve ser solicitado diretamente ao operador da respectiva instância.

## 1.1) Encarregado pelo tratamento (LGPD art. 41)

- Encarregado (DPO): Kaiky Brito Ribeiro (59.034.123 KAIKY BRITO RIBEIRO, CNPJ 59.034.123/0001-96).
- Contato do encarregado: `https://wa.me/<WHATSAPP_PUBLIC_CONTACT_NUMBER>` (assunto recomendado: "ENCARREGADO LGPD").
- Divulgação pública mantida para transparência regulatória.

## 2) Tabela de tratamento de dados

| Categoria de dados                                                           | Finalidade principal                                   | Base legal (LGPD art. 7)                                                            | Prazo de retenção                                                        | Compartilhamentos                               | Transferência internacional                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------- |
| Identificação de conta (sub Google, e-mail, owner_jid)                       | Autenticação, segurança de sessão e vínculo de conta   | Execução de contrato; legítimo interesse                                            | Enquanto a conta estiver ativa + até 12 meses para trilha técnica        | Provedores de cloud, autenticação e e-mail      | Pode ocorrer quando fornecedor tiver infraestrutura fora do Brasil  |
| Credenciais e eventos de login (sessão, IP, user agent, aceite jurídico)     | Prevenir fraude, auditoria e prova de consentimento    | Legítimo interesse; exercício regular de direitos; obrigação legal quando aplicável | Até 24 meses, salvo retenção superior por obrigação legal                | Provedores de cloud/segurança/monitoramento     | Pode ocorrer via suboperadores globais com salvaguardas contratuais |
| Conteúdo de mensagens e metadados (quando funcionalidade estiver habilitada) | Execução de automações, moderação, suporte e segurança | Execução de contrato; legítimo interesse; consentimento quando exigido              | Conforme finalidade declarada pelo cliente e políticas técnicas vigentes | Infraestrutura de processamento e armazenamento | Pode ocorrer conforme região do provedor contratado                 |
| Logs de API, erros e telemetria                                              | Observabilidade, capacidade, resposta a incidentes     | Legítimo interesse                                                                  | 6 a 24 meses, conforme criticidade operacional                           | Monitoramento e observabilidade                 | Pode ocorrer (fornecedores globais)                                 |
| Dados de suporte (tickets, e-mails, evidências)                              | Atendimento, correções e histórico de suporte          | Execução de contrato; exercício regular de direitos                                 | Até 5 anos para defesa administrativa/judicial, quando cabível           | Plataforma de e-mail e atendimento              | Pode ocorrer conforme local de processamento do provedor            |

## 3) Compartilhamento de dados

- Compartilhamos somente com suboperadores e parceiros estritamente necessários para operar o serviço.
- Compartilhamos com autoridades públicas quando houver obrigação legal, ordem judicial ou requisição válida.
- Não comercializamos dados pessoais como produto.

## 4) Transferências internacionais

- Alguns fornecedores podem processar dados fora do Brasil.
- As transferências internacionais seguem salvaguardas contratuais, controles técnicos e avaliação de risco compatíveis com a LGPD e regulamentação da ANPD.
- Mecanismos adotados podem incluir cláusulas contratuais e avaliação por finalidade/risco.
- O inventário de suboperadores publicado em `/suboperadores/` informa categoria e status de localização/região.

## 5) Retenção e descarte

- Mantemos dados somente pelo tempo necessário para as finalidades legítimas e exigências legais.
- Encerrada a finalidade, os dados podem ser anonimizados, bloqueados ou eliminados, ressalvadas obrigações legais e necessidade probatória.

## 6) Direitos do titular (art. 18 LGPD)

- Confirmação de tratamento e acesso.
- Correção de dados incompletos ou desatualizados.
- Anonimização, bloqueio ou eliminação quando cabível.
- Portabilidade (quando tecnicamente viável).
- Oposição e revisão de tratamento nas hipóteses legais.
- Petição perante ANPD e autoridades competentes, quando cabível.
- Quando aplicável, declaração clara e completa em até 15 dias (LGPD art. 19), sem prejuízo de resposta simplificada imediata quando possível.

Prazos operacionais e fluxo completo: ver `docs/security/dsar-lgpd-runbook-2026-03-07.md`.

## 7) Segurança

- Criptografia em trânsito (TLS), controles de acesso por privilégio mínimo, logs e trilhas de auditoria.
- Monitoramento técnico e resposta a incidentes com critério LGPD/ANPD.
- Havendo incidente com risco ou dano relevante aos titulares, comunicação à ANPD e aos titulares será avaliada e realizada quando exigida por lei/regulamentação.
- Quando aplicável ao controlador, observar prazo regulatório vigente para comunicação de incidente (incluindo 3 dias úteis previstos no regulamento atual da ANPD).

## 8) Atualizações desta política

- Esta política pode ser atualizada para refletir mudanças legais, regulatórias e operacionais.
- Versões e aceite eletrônico podem ser registrados para prova jurídica (hash da versão, timestamp, IP e user agent).
