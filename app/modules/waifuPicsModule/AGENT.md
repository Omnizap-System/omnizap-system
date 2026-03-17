# WaifuPicsModule Agent Guide

Este arquivo e destinado a agentes de IA para gerar respostas no contexto dos comandos deste modulo.

## Fonte de Verdade

- arquivo_base: `app/modules/waifuPicsModule/commandConfig.json`
- schema_version: `2.0.0`
- module_enabled: `true`
- generated_at: `2026-03-17T04:04:14.195Z`

## Escopo do Modulo

- module: `waifuPicsModule`
- source_files:
- waifuPicsCommand.js
- total_commands: `3`
- total_enabled_commands: `3`

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
- category: anime
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

### waifu

- id: waifupics.waifu
- aliases: waifupics, wp
- enabled: true
- categoria: anime
- descricao: Receba uma imagem incrível de anime (SFW)! Escolha uma categoria como 'neko' ou 'waifu'. ✨
- permissao_necessaria: Livre para todos!
- version: 1.0.0
- stability: stable
- deprecated: nao
- risk_level: low
- local_de_uso:
- Privado
- Grupos
- metodos_de_uso:
- <prefix>waifu <categoria>
- <prefix>wp neko
- mensagens_uso (variantes):
- default:
- 🖼️ _Como usar:_ <prefix>waifu <categoria>
- Exemplos rápidos: <prefix>waifu neko | <prefix>wp hug
- Quer ver todas as categorias disponíveis? Use <prefix>waifuajuda.
- subcomandos:
- (nenhum)
- argumentos:
- categoria | tipo: string | obrigatorio | validacao: categoria SFW suportada | default: null | posicao: 0
- pre_condicoes:
- requer_grupo: nao
- requer_admin: nao
- requer_admin_principal: nao
- requer_google_login: sim
- requer_nsfw: nao
- requer_midia: nao
- requer_mensagem_respondida: nao
- rate_limit:
- max: null
- janela_ms: null
- escopo: sem_rate_limit_explicito
- acesso:
- somente_premium: nao
- planos_permitidos: comum, premium
- limite_uso_por_plano:
- comum: max=10, janela_ms=300000, escopo=usuario
- premium: max=35, janela_ms=300000, escopo=usuario
- informacoes_coletadas:
- ID do chat
- ID do remetente
- Comando e categoria escolhida
- dependencias_externas:
- Waifu.pics API
- efeitos_colaterais:
- consulta API externa
- envia imagem no chat
- respostas_padrao:
- success: ✅ Pedido recebido! Aqui vai sua imagem.
  Dica: você pode pedir outra categoria no próximo comando (ex.: <prefix>waifu neko).
- usage_error: ❗ Não entendi o formato do comando.
  Exemplos:
  • <prefix>waifu neko
  • <prefix>waifunsfw waifu
  Para ver todas as categorias: <prefix>waifuajuda
- permission_error: 🔒 Este comando não está liberado para você neste contexto.
  Se for NSFW em grupo, peça para um admin usar <prefix>nsfw on.
- sucesso: ✅ Imagem enviada com sucesso!
  Exemplo de próximo pedido: <prefix>waifu hug
- erro_uso: ❗ Categoria inválida ou ausente.
  Exemplos: <prefix>waifu neko | <prefix>wp waifu
  Veja a lista completa em <prefix>waifuajuda.
- erro_permissao: 🔒 Não consegui liberar este pedido para seu perfil.
  Se achar que é engano, verifique seu plano e tente novamente.
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
- analytics_event: whatsapp_command_wp
- tags_log: whatsapp, command, waifuPicsModule, wp
- nivel_log: info
- privacidade:
- dados_sensiveis:
- chat_identifier
- sender_identifier
- command_content
- retencao: standard_app_logs
- base_legal: service_execution_and_legitimate_interest
- docs:
- summary: Busca e envia imagens aleatórias de anime (Safe For Work).
- usage_examples: <prefix>waifu waifu, <prefix>wp neko
- usage_variants.default: <prefix>waifu <categoria>, <prefix>wp neko
- behavior:
- type: argument_driven
- allowed_actions: (nenhum)
- limits:
- usage_description: sem limite especifico
- rate_limit.max: null
- rate_limit.janela_ms: null
- rate_limit.escopo: sem_rate_limit_explicito
- access.somente_premium: false
- access.planos_permitidos: comum, premium
- plan_limits.comum.max: 10
- plan_limits.comum.janela_ms: 300000
- plan_limits.comum.escopo: usuario
- plan_limits.premium.max: 35
- plan_limits.premium.janela_ms: 300000
- plan_limits.premium.escopo: usuario
- discovery:
- keywords: waifu, waifupics, anime, privado, grupo
- faq_queries: como usar waifu, o que faz waifu, comando waifu
- user_phrasings: quero usar waifu, me ajuda com waifu, envia imagem sfw da
- suggestion_priority: 100
- handler:
- file: waifuPicsCommand.js
- method: handleWaifuPicsCommand
- command_case: waifu

### waifunsfw

- id: waifupics.waifunsfw
- aliases: waifupicsnsfw, wpnsfw
- enabled: true
- categoria: anime
- descricao: Mande aquela imagem picante (NSFW). Exige que o grupo autorize! 🔞
- permissao_necessaria: Membros em grupos com NSFW ativado.
- version: 1.0.0
- stability: stable
- deprecated: nao
- risk_level: low
- local_de_uso:
- Privado
- Grupos
- metodos_de_uso:
- <prefix>waifunsfw <categoria>
- <prefix>wpnsfw waifu
- mensagens_uso (variantes):
- default:
- 🔞 _Como usar:_ <prefix>waifunsfw <categoria>
- Exemplos rápidos: <prefix>waifunsfw waifu | <prefix>wpnsfw neko
- Pré-requisitos: plano Premium; em grupo, NSFW ativo com <prefix>nsfw on.
- subcomandos:
- (nenhum)
- argumentos:
- categoria | tipo: string | obrigatorio | validacao: categoria NSFW suportada | default: null | posicao: 0
- pre_condicoes:
- requer_grupo: nao
- requer_admin: nao
- requer_admin_principal: nao
- requer_google_login: sim
- requer_nsfw: sim
- requer_midia: nao
- requer_mensagem_respondida: nao
- rate_limit:
- max: null
- janela_ms: null
- escopo: sem_rate_limit_explicito
- acesso:
- somente_premium: sim
- planos_permitidos: premium
- limite_uso_por_plano:
- comum: max=10, janela_ms=300000, escopo=usuario
- premium: max=35, janela_ms=300000, escopo=usuario
- informacoes_coletadas:
- ID do chat
- ID do remetente
- Categoria
- dependencias_externas:
- Waifu.pics API
- configuração de NSFW por grupo
- efeitos_colaterais:
- consulta API externa
- envia imagem NSFW no chat
- respostas_padrao:
- success: ✅ Pedido recebido! Aqui vai sua imagem.
  Dica: você pode pedir outra categoria no próximo comando (ex.: <prefix>waifu neko).
- usage_error: ❗ Não entendi o formato do comando.
  Exemplos:
  • <prefix>waifu neko
  • <prefix>waifunsfw waifu
  Para ver todas as categorias: <prefix>waifuajuda
- permission_error: 🔒 Este comando não está liberado para você neste contexto.
  Se for NSFW em grupo, peça para um admin usar <prefix>nsfw on.
- sucesso: 🔞 Imagem NSFW enviada.
  Exemplo de próximo pedido: <prefix>waifunsfw neko
- erro_uso: ❗ Categoria NSFW inválida ou ausente.
  Exemplos: <prefix>waifunsfw waifu | <prefix>wpnsfw neko
  Veja opções em <prefix>waifuajuda.
- erro_permissao: 🔒 Este comando NSFW exige acesso Premium.
  Em grupos, também é preciso NSFW ativo com <prefix>nsfw on.
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
- analytics_event: whatsapp_command_wpnsfw
- tags_log: whatsapp, command, waifuPicsModule, wpnsfw
- nivel_log: info
- privacidade:
- dados_sensiveis:
- chat_identifier
- sender_identifier
- command_content
- retencao: standard_app_logs
- base_legal: service_execution_and_legitimate_interest
- docs:
- summary: Envia imagens de anime para maiores (Not Safe For Work) se permitido.
- usage_examples: <prefix>waifunsfw waifu, <prefix>wpnsfw neko
- usage_variants.default: <prefix>waifunsfw <categoria>, <prefix>wpnsfw waifu
- behavior:
- type: argument_driven
- allowed_actions: (nenhum)
- limits:
- usage_description: depende de configuracao global e do grupo
- rate_limit.max: null
- rate_limit.janela_ms: null
- rate_limit.escopo: sem_rate_limit_explicito
- access.somente_premium: true
- access.planos_permitidos: premium
- plan_limits.comum.max: 10
- plan_limits.comum.janela_ms: 300000
- plan_limits.comum.escopo: usuario
- plan_limits.premium.max: 35
- plan_limits.premium.janela_ms: 300000
- plan_limits.premium.escopo: usuario
- discovery:
- keywords: waifunsfw, waifupicsnsfw, anime, privado, grupo
- faq_queries: como usar waifunsfw, o que faz waifunsfw, comando waifunsfw
- user_phrasings: quero usar waifunsfw, me ajuda com waifunsfw, envia imagem nsfw da
- suggestion_priority: 100
- handler:
- file: waifuPicsCommand.js
- method: handleWaifuPicsCommand
- command_case: waifunsfw

### waifuajuda

- id: waifupics.waifuajuda
- aliases: wppicshelp
- enabled: true
- categoria: anime
- descricao: Veja todas as categorias de fotos anime que eu posso te enviar! 📖
- permissao_necessaria: Livre para todos!
- version: 1.0.0
- stability: stable
- deprecated: nao
- risk_level: low
- local_de_uso:
- Privado
- Grupos
- metodos_de_uso:
- <prefix>waifuajuda
- mensagens_uso (variantes):
- default:
- 📖 _Como usar:_ <prefix>waifuajuda
- Depois do guia, teste: <prefix>waifu neko
- Para NSFW: <prefix>waifunsfw waifu (Premium; em grupo exige <prefix>nsfw on).
- subcomandos:
- (nenhum)
- argumentos:
- (nenhum)
- pre_condicoes:
- requer_grupo: nao
- requer_admin: nao
- requer_admin_principal: nao
- requer_google_login: sim
- requer_nsfw: nao
- requer_midia: nao
- requer_mensagem_respondida: nao
- rate_limit:
- max: null
- janela_ms: null
- escopo: sem_rate_limit_explicito
- acesso:
- somente_premium: nao
- planos_permitidos: comum, premium
- limite_uso_por_plano:
- comum: max=10, janela_ms=300000, escopo=usuario
- premium: max=35, janela_ms=300000, escopo=usuario
- informacoes_coletadas:
- ID do chat
- ID do remetente
- dependencias_externas:
- Waifu.pics API
- efeitos_colaterais:
- envia mensagem de ajuda
- respostas_padrao:
- success: ✅ Pedido recebido! Aqui vai sua imagem.
  Dica: você pode pedir outra categoria no próximo comando (ex.: <prefix>waifu neko).
- usage_error: ❗ Não entendi o formato do comando.
  Exemplos:
  • <prefix>waifu neko
  • <prefix>waifunsfw waifu
  Para ver todas as categorias: <prefix>waifuajuda
- permission_error: 🔒 Este comando não está liberado para você neste contexto.
  Se for NSFW em grupo, peça para um admin usar <prefix>nsfw on.
- sucesso: 📚 Guia enviado com sucesso.
  Agora experimente: <prefix>waifu neko
- erro_uso: ℹ️ Este comando não precisa de argumentos.
  Use apenas: <prefix>waifuajuda
- erro_permissao: 🔒 Não consegui mostrar o guia neste contexto.
  Tente novamente no privado ou em um grupo permitido.
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
- analytics_event: whatsapp_command_wppicshelp
- tags_log: whatsapp, command, waifuPicsModule, wppicshelp
- nivel_log: info
- privacidade:
- dados_sensiveis:
- chat_identifier
- sender_identifier
- command_content
- retencao: standard_app_logs
- base_legal: service_execution_and_legitimate_interest
- docs:
- summary: Exibe o menu de ajuda detalhado do módulo Waifu.pics com todas as categorias.
- usage_examples: <prefix>waifuajuda
- usage_variants.default: <prefix>waifuajuda
- behavior:
- type: simple_action
- allowed_actions: (nenhum)
- limits:
- usage_description: sem limite especifico
- rate_limit.max: null
- rate_limit.janela_ms: null
- rate_limit.escopo: sem_rate_limit_explicito
- access.somente_premium: false
- access.planos_permitidos: comum, premium
- plan_limits.comum.max: 10
- plan_limits.comum.janela_ms: 300000
- plan_limits.comum.escopo: usuario
- plan_limits.premium.max: 35
- plan_limits.premium.janela_ms: 300000
- plan_limits.premium.escopo: usuario
- discovery:
- keywords: waifuajuda, anime, privado, grupo
- faq_queries: como usar waifuajuda, o que faz waifuajuda, comando waifuajuda
- user_phrasings: quero usar waifuajuda, me ajuda com waifuajuda, mostra ajuda e categorias
- suggestion_priority: 100
- handler:
- file: waifuPicsCommand.js
- method: getWaifuPicsUsageText
- command_case: waifuajuda
