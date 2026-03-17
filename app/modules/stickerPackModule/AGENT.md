# StickerPackModule Agent Guide

Este arquivo e destinado a agentes de IA para gerar respostas no contexto dos comandos deste modulo.

## Fonte de Verdade

- arquivo_base: `app/modules/stickerPackModule/commandConfig.json`
- schema_version: `2.0.0`
- module_enabled: `true`
- generated_at: `2026-03-17T04:04:14.195Z`

## Escopo do Modulo

- module: `stickerPackModule`
- source_files:
- stickerPackCommandHandlers.js
- total_commands: `1`
- total_enabled_commands: `1`

## Defaults Schema v2

- inheritance_mode: deep_merge_with_command_overrides
- compatibility_mode: legacy_and_v2_fields
- legacy_field_aliases:
- descricao: description
- metodos_de_uso: usage
- permissao_necessaria: permission
- local_de_uso: contexts
- informacoes_coletadas: collected_data
- pre_condicoes: requirements
- dependencias_externas: dependencies
- efeitos_colaterais: side_effects
- observabilidade: observability
- privacidade: privacy
- limite_uso_por_plano: plan_limits
- argumentos: arguments
- acesso: access
- defaults.command:
- enabled: true
- category: figurinhas
- version: 1.0.0
- stability: stable
- deprecated: false
- replaced_by: null
- risk_level: medium
- defaults.requirements (legacy view):
- requer_grupo: nao
- requer_admin: nao
- requer_admin_principal: nao
- requer_google_login: sim
- requer_nsfw: nao
- requer_midia: nao
- requer_mensagem_respondida: nao

## Protocolo de Resposta para IA

- Passo 1: identificar comando pelo token apos o prefixo.
- Passo 2: resolver alias para nome canonico usando campo `aliases`.
- Passo 3: validar `enabled`, `pre_condicoes`, permissao e local de uso.
- Passo 4: se houver erro de uso, responder com `mensagens_uso` (quando existir) ou `metodos_de_uso`.
- Passo 5: seguir `respostas_padrao` como fallback de texto.
- Passo 6: considerar `informacoes_coletadas`, `privacidade` e `observabilidade` ao elaborar resposta.

## Regras de Seguranca para IA

- A IA orienta, mas nao executa acao administrativa automaticamente.
- Nao inventar comandos, subcomandos ou permissao fora do JSON.
- Sempre informar onde pode usar (grupo/privado) e quem pode usar.
- Em duvida de permissao, responder com orientacao conservadora.

## Catalogo de Comandos

### pacote

- id: stickerpack.pacote
- aliases: packs, pacotes, pack
- enabled: true
- categoria: figurinhas
- descricao: Gerencia packs de figurinhas (criar, listar, adicionar, enviar).
- permissao_necessaria: usuario comum
- version: 1.0.0
- stability: stable
- deprecated: nao
- risk_level: low
- local_de_uso:
- privado
- grupo
- metodos_de_uso:
- <prefix>pacote help
- <prefix>pacote create meupack
- <prefix>pacote list
- <prefix>pacote add <pacote>
- <prefix>pacote send <pacote>
- mensagens_uso (variantes):
- default:
- <prefix>pacote help
- <prefix>pacote create meupack
- <prefix>pacote list
- <prefix>pacote add <pacote>
- <prefix>pacote send <pacote>
- subcomandos:
- help
- create
- list
- info
- add
- setcover
- setdesc
- setpublisher
- send
- rename
- remove
- delete
- reorder
- argumentos:
- subcomando | tipo: string | obrigatorio | validacao: ação de gerenciamento de pack | default: null | posicao: 0
- parametros | tipo: array | opcional | validacao: dependente do subcomando | default: null | posicao: 1
- pre_condicoes:
- requer_grupo: nao
- requer_admin: nao
- requer_admin_principal: nao
- requer_google_login: sim
- requer_nsfw: nao
- requer_midia: nao
- requer_mensagem_respondida: nao
- rate_limit:
- max: 20
- janela_ms: 60000
- escopo: usuario
- acesso:
- somente_premium: nao
- planos_permitidos: comum, premium
- limite_uso_por_plano:
- comum: max=12, janela_ms=300000, escopo=usuario
- premium: max=45, janela_ms=300000, escopo=usuario
- informacoes_coletadas:
- identificador do chat (remoteJid)
- identificador do remetente (senderJid)
- texto do comando e argumentos
- contexto da mensagem (citacao e mencoes, quando existir)
- subcomando e argumentos do pack
- figurinha da mensagem atual/citada (para add/setcover)
- estado de rate limit por usuario
- dados de packs do usuario no armazenamento interno
- dependencias_externas:
- banco de dados de packs
- armazenamento de assets de figurinha
- efeitos_colaterais:
- cria/atualiza packs no banco
- pode armazenar/remover assets de figurinha
- respostas_padrao:
- success: Comando executado com sucesso.
- usage_error: Formato de uso inválido. Consulte metodos_de_uso.
- permission_error: Permissão insuficiente para executar este comando.
- sucesso: Comando executado com sucesso.
- erro_uso: Formato de uso inválido. Consulte metodos_de_uso.
- erro_permissao: Permissão insuficiente para executar este comando.
- mensagens_sistema:
- (nao informado)
- limites_operacionais:
- (nao informado)
- opcoes:
- toggle_on_off_status.type: toggle
- toggle_on_off_status.allowed_actions: on, off, status
- toggle_on_off_status.action_argument: acao
- add_remove_list.type: list_management
- add_remove_list.allowed_actions: add, remove, list
- add_remove_list.action_argument: acao
- approve_reject.type: moderation_decision
- approve_reject.allowed_actions: approve, reject
- approve_reject.action_argument: acao
- approve_reject.requires_targets: true
- set_status_reset.type: configuration_window
- set_status_reset.allowed_actions: set, status, reset
- set_status_reset.action_argument: valor
- observabilidade:
- event_name: command.executed
- analytics_event: whatsapp_command_pack
- tags_log: whatsapp, command, stickerPackModule, pack
- nivel_log: info
- privacidade:
- dados_sensiveis:
- sender_identifier
- retencao: standard_app_logs
- base_legal: service_execution_and_legitimate_interest
- docs:
- summary: Gerencia packs de figurinhas (criar, listar, adicionar, enviar).
- usage_examples: <prefix>pacote help, <prefix>pacote create meupack, <prefix>pacote list, <prefix>pacote add <pacote>, <prefix>pacote send <pacote>
- usage_variants.default: <prefix>pacote help, <prefix>pacote create meupack, <prefix>pacote list, <prefix>pacote add <pacote>, <prefix>pacote send <pacote>
- behavior:
- type: list_management
- allowed_actions: add, remove, list
- action_argument: acao
- limits:
- usage_description: rate limit por janela e limite de itens por pack
- rate_limit.max: 20
- rate_limit.janela_ms: 60000
- rate_limit.escopo: usuario
- access.somente_premium: false
- access.planos_permitidos: comum, premium
- plan_limits.comum.max: 12
- plan_limits.comum.janela_ms: 300000
- plan_limits.comum.escopo: usuario
- plan_limits.premium.max: 45
- plan_limits.premium.janela_ms: 300000
- plan_limits.premium.escopo: usuario
- discovery:
- keywords: pacote, packs, figurinhas, privado, grupo
- faq_queries: como usar pacote, o que faz pacote, comando pacote
- user_phrasings: quero usar pacote, me ajuda com pacote, gerencia packs de figurinhas
- suggestion_priority: 100
- handler:
- file: stickerPackCommandHandlers.js
- method: handlePackCommand
- command_case: pacote
