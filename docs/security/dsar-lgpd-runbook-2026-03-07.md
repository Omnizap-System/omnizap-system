# Runbook DSAR/LGPD (Direitos do Titular)

Data: 2026-03-07

## 1) Objetivo

Padronizar resposta para direitos do titular: acesso, correção, exclusão, oposição e portabilidade.

## 2) Canais de entrada

- WhatsApp oficial: `https://wa.me/<WHATSAPP_PUBLIC_CONTACT_NUMBER>`
- Canal interno de compliance (registro em ticket obrigatório)

## 3) Papéis e responsáveis

- DPO/Privacidade (owner do caso): valida base legal e resposta final.
- Engenharia: localiza dados, executa exportação/correção/exclusão.
- Segurança: valida risco e cadeia de evidência.
- Suporte: confirma identidade e comunica status ao titular.

## 4) Prazos operacionais

| Tipo de solicitação                        | Prazo alvo interno   |
| ------------------------------------------ | -------------------- |
| Confirmação de recebimento                 | até 2 dias corridos  |
| Acesso/confirmação de tratamento           | até 7 dias corridos  |
| Correção                                   | até 7 dias corridos  |
| Exclusão/anonimização (quando cabível)     | até 15 dias corridos |
| Oposição/revisão                           | até 10 dias corridos |
| Portabilidade (quando tecnicamente viável) | até 15 dias corridos |

Observação: prevalecem prazos legais aplicáveis quando menores.
Para pedidos enquadrados no art. 19 da LGPD, observar resposta simplificada imediata quando possível e declaração clara/completa em até 15 dias.

## 5) Fluxo operacional

1. Registrar ticket com ID único e timestamp UTC.
2. Confirmar identidade mínima do solicitante.
3. Classificar direito solicitado e base jurídica.
4. Mapear sistemas/tabelas afetadas.
5. Executar ação técnica (consulta, ajuste, exclusão, exportação).
6. Revisão jurídica/privacidade.
7. Responder titular com protocolo e resumo da ação.
8. Encerrar com evidências anexas e métricas de SLA.

## 6) Matriz por direito

### 6.1 Acesso

- Entregar resumo dos dados tratados e finalidades.
- Incluir categorias, origem e compartilhamentos principais.

### 6.2 Correção

- Corrigir dado incompleto/inexato/desatualizado.
- Registrar antes/depois e fundamento da alteração.

### 6.3 Exclusão

- Eliminar ou anonimizar quando não houver base legal de retenção.
- Se houver retenção obrigatória, informar bloqueio e justificativa.

### 6.4 Oposição

- Avaliar legitimidade do pedido conforme base legal aplicável.
- Suspender tratamento contestado quando juridicamente cabível.

### 6.5 Portabilidade

- Fornecer formato estruturado e interoperável quando tecnicamente viável.
- Excluir segredos comerciais e dados de terceiros não transferíveis.

## 7) Evidências obrigatórias

- ID do ticket, timestamps e responsáveis por etapa.
- Comprovante de identidade validado.
- Consulta técnica executada e resultado.
- Mensagem de resposta final ao titular.

## 8) Escalonamento

Escalonar para jurídico + segurança quando houver:

- risco de incidente de segurança;
- pedido envolvendo alto volume de titulares;
- conflito entre pedido e obrigação legal de retenção.
