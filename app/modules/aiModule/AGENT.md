# AiModule Agent Guide

Este arquivo e destinado a agentes de IA para gerar respostas no contexto dos comandos deste modulo.

## Fonte de Verdade

- arquivo_base: `app/modules/aiModule/commandConfig.json`
- schema_version: `2.0.0`
- module_enabled: `true`
- generated_at: `2026-03-17T04:04:14.195Z`

## Escopo do Modulo

- module: `aiModule`
- source_files:
- catCommand.js
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
- category: ia
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

### ia

- id: ai.ia
- aliases: cat
- enabled: true
- categoria: ia
- descricao: Perguntas para IA com suporte opcional a resposta em audio.
- permissao_necessaria: usuario premium
- version: 1.0.0
- stability: stable
- deprecated: nao
- risk_level: low
- local_de_uso:
- privado
- grupo
- metodos_de_uso:
- <prefix>ia sua pergunta
- <prefix>ia --audio sua pergunta
- mensagens_uso (variantes):
- default:
- _<prefix>ia_ [--audio] sua pergunta
- _<prefix>ia_ (responda ou envie uma imagem com legenda)
- Opções:
- --audio | --texto
- --detail low | high | auto
- Exemplo:
- _<prefix>ia_ Explique como funciona a fotossíntese.
- _<prefix>ia_ --audio Resuma a imagem.
- subcomandos:
- (nenhum)
- argumentos:
- prompt | tipo: string | opcional | validacao: texto livre; pode usar contexto de mídia | default: null | posicao: 0
- flags | tipo: array | opcional | validacao: aliases de áudio/texto suportados | default: null | posicao: 1
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
- somente_premium: sim
- planos_permitidos: premium
- limite_uso_por_plano:
- comum: max=8, janela_ms=300000, escopo=usuario
- premium: max=40, janela_ms=300000, escopo=usuario
- informacoes_coletadas:
- identificador do chat (remoteJid)
- identificador do remetente (senderJid)
- texto do comando e argumentos
- contexto da mensagem (citacao e mencoes, quando existir)
- prompt textual enviado ao modelo de IA
- flags de resposta (ex.: audio/voz)
- midia anexada/citada para analise multimodal (quando houver)
- identidade do usuario para sessao e contexto de conversa
- dependencias_externas:
- OpenAI API
- efeitos_colaterais:
- envia resposta textual/áudio de IA
- respostas_padrao:
- success: Comando executado com sucesso.
- usage_error: Formato de uso inválido. Consulte metodos_de_uso.
- permission_error: Permissão insuficiente para executar este comando.
- sucesso: Comando executado com sucesso.
- erro_uso: Formato de uso inválido. Consulte metodos_de_uso.
- erro_permissao: Permissão insuficiente para executar este comando.
- mensagens_sistema:
- premium_only: ⭐ _Recurso Premium_

Este comando é exclusivo para usuários Premium.
Para liberar o acesso, fale com o admin do sistema no privado.

- openai_nao_configurada: ⚠️ _IA indisponível no momento_

Este recurso está em manutenção.
Se precisar de ajuda, fale com o admin do sistema no privado.

- imagem_muito_grande: ⚠️ A imagem está muito grande para análise (limite {{limite_mb}} MB). Envie uma imagem menor.
- imagem_download_falhou: ⚠️ Não consegui ler sua imagem agora. Reenvie a imagem.
  Se o erro continuar, fale com o admin do sistema no privado.
- resposta_vazia: ⚠️ Não consegui montar uma resposta agora. Tente novamente em instantes.
- audio_muito_longo: ⚠️ A resposta ficou grande para áudio. Vou te enviar em texto.
- audio_falhou: ⚠️ Não consegui gerar o áudio agora. Vou te responder em texto.
- erro_openai: ❌ _Não consegui responder agora_

Tente novamente em instantes.
Se o erro continuar, fale com o admin do sistema no privado.

- usage_header: 🤖 _Comando CAT_
- resposta_prefixo_texto: 🐈‍⬛
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
- parse.audio_flags: --audio, --voz, --voice, --tts, -a
- parse.text_flags: --texto, --text, --txt
- parse.image_detail_aliases.low: low
- parse.image_detail_aliases.high: high
- parse.image_detail_aliases.auto: auto
- parse.image_detail_aliases.baixo: low
- parse.image_detail_aliases.baixa: low
- parse.image_detail_aliases.alto: high
- parse.image_detail_aliases.alta: high
- parse.image_detail_aliases.automatico: auto
- parse.image_detail_aliases.automático: auto
- observabilidade:
- event_name: command.executed
- analytics_event: whatsapp_command_cat
- tags_log: whatsapp, command, aiModule, cat
- nivel_log: info
- privacidade:
- dados_sensiveis:
- chat_identifier
- sender_identifier
- command_content
- retencao: standard_app_logs
- base_legal: service_execution_and_legitimate_interest
- docs:
- summary: Perguntas para IA com suporte opcional a resposta em audio.
- usage_examples: <prefix>ia sua pergunta, <prefix>ia --audio sua pergunta
- usage_variants.default: _<prefix>ia_ [--audio] sua pergunta, _<prefix>ia_ (responda ou envie uma imagem com legenda), , Opções:, --audio | --texto, --detail low | high | auto, , Exemplo:, _<prefix>ia_ Explique como funciona a fotossíntese., _<prefix>ia_ --audio Resuma a imagem.
- behavior:
- type: argument_driven
- allowed_actions: (nenhum)
- limits:
- usage_description: texto sujeito a limites da API
- rate_limit.max: null
- rate_limit.janela_ms: null
- rate_limit.escopo: sem_rate_limit_explicito
- access.somente_premium: true
- access.planos_permitidos: premium
- plan_limits.comum.max: 8
- plan_limits.comum.janela_ms: 300000
- plan_limits.comum.escopo: usuario
- plan_limits.premium.max: 40
- plan_limits.premium.janela_ms: 300000
- plan_limits.premium.escopo: usuario
- discovery:
- keywords: ia, ia, privado, grupo
- faq_queries: como usar ia, o que faz ia, comando ia
- user_phrasings: quero usar ia, me ajuda com ia, perguntas para ia com
- suggestion_priority: 100
- handler:
- file: catCommand.js
- method: handleCatCommand
- command_case: ia

### iaimagem

- id: ai.iaimagem
- aliases: catimage, catimg
- enabled: true
- categoria: ia
- descricao: Gera/edita imagem com IA por prompt.
- permissao_necessaria: usuario premium
- version: 1.0.0
- stability: stable
- deprecated: nao
- risk_level: low
- local_de_uso:
- privado
- grupo
- metodos_de_uso:
- <prefix>iaimagem seu prompt
- <prefix>iaimagem --size 1536x1024 seu prompt
- mensagens_uso (variantes):
- default:
- _<prefix>iaimagem_ seu prompt
- _<prefix>iaimagem_ (responda uma imagem com legenda para editar)
- Opções:
- --size 1024x1024 | 1024x1536 | 1536x1024 | auto
- --quality low | medium | high | auto
- --format png | jpeg | webp
- --background transparent | opaque | auto
- --compression 0-100
- Exemplo:
- _<prefix>iaimagem_ --size 1536x1024 Um gato astronauta em aquarela.
- subcomandos:
- (nenhum)
- argumentos:
- prompt | tipo: string | opcional | validacao: texto livre para gerar/editar imagem | default: null | posicao: 0
- size | tipo: string | opcional | validacao: auto|1024x1024|1024x1536|1536x1024 | default: null | posicao: 1
- quality | tipo: string | opcional | validacao: auto|low|medium|high | default: null | posicao: 2
- format | tipo: string | opcional | validacao: png|jpeg|webp | default: null | posicao: 3
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
- somente_premium: sim
- planos_permitidos: premium
- limite_uso_por_plano:
- comum: max=8, janela_ms=300000, escopo=usuario
- premium: max=40, janela_ms=300000, escopo=usuario
- informacoes_coletadas:
- identificador do chat (remoteJid)
- identificador do remetente (senderJid)
- texto do comando e argumentos
- contexto da mensagem (citacao e mencoes, quando existir)
- prompt de geracao/edicao de imagem
- opcoes de geracao (size, quality, format, background)
- imagem enviada/citada para edicao (quando houver)
- dependencias_externas:
- OpenAI API
- efeitos_colaterais:
- envia imagem gerada/editada por IA
- respostas_padrao:
- success: Comando executado com sucesso.
- usage_error: Formato de uso inválido. Consulte metodos_de_uso.
- permission_error: Permissão insuficiente para executar este comando.
- sucesso: Comando executado com sucesso.
- erro_uso: Formato de uso inválido. Consulte metodos_de_uso.
- erro_permissao: Permissão insuficiente para executar este comando.
- mensagens_sistema:
- premium_only: ⭐ _Recurso Premium_

Este comando é exclusivo para usuários Premium.
Para liberar o acesso, fale com o admin do sistema no privado.

- openai_nao_configurada: ⚠️ _Gerador de imagem indisponível_

Este recurso está em manutenção.
Se precisar de ajuda, fale com o admin do sistema no privado.

- imagem_muito_grande: ⚠️ A imagem está muito grande para edição (limite {{limite_mb}} MB). Envie uma imagem menor.
- imagem_download_falhou: ⚠️ Não consegui ler sua imagem agora. Reenvie a imagem.
  Se o erro continuar, fale com o admin do sistema no privado.
- opcoes_invalidas: ⚠️ Algumas opções do comando estão inválidas.
  Detalhes: {{detalhes}}

Use _{{prefix}}catimg_ sem opções para ver o formato correto.

- resposta_vazia: ⚠️ Não consegui gerar a imagem agora. Tente novamente em instantes.
- erro_openai: ❌ _Não consegui gerar sua imagem agora_

Tente novamente em instantes.
Se o erro continuar, fale com o admin do sistema no privado.

- usage_header: 🖼️ _Imagem IA_
- resposta_prefixo_texto_imagem: 🖼️
- imagem_caption_sucesso: 🖼️ Imagem gerada.
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
- geracao_imagem.size_options: auto, 1024x1024, 1024x1536, 1536x1024
- geracao_imagem.size_aliases.1024: 1024x1024
- geracao_imagem.size_aliases.square: 1024x1024
- geracao_imagem.size_aliases.quadrado: 1024x1024
- geracao_imagem.size_aliases.portrait: 1024x1536
- geracao_imagem.size_aliases.retrato: 1024x1536
- geracao_imagem.size_aliases.landscape: 1536x1024
- geracao_imagem.size_aliases.paisagem: 1536x1024
- geracao_imagem.size_aliases.auto: auto
- geracao_imagem.quality_options: auto, low, medium, high
- geracao_imagem.quality_aliases.baixa: low
- geracao_imagem.quality_aliases.baixo: low
- geracao_imagem.quality_aliases.media: medium
- geracao_imagem.quality_aliases.média: medium
- geracao_imagem.quality_aliases.medio: medium
- geracao_imagem.quality_aliases.médio: medium
- geracao_imagem.quality_aliases.alta: high
- geracao_imagem.quality_aliases.alto: high
- geracao_imagem.quality_aliases.auto: auto
- geracao_imagem.format_options: png, jpeg, webp
- geracao_imagem.format_aliases.jpg: jpeg
- geracao_imagem.format_aliases.jpeg: jpeg
- geracao_imagem.format_aliases.png: png
- geracao_imagem.format_aliases.webp: webp
- geracao_imagem.background_options: auto, transparent, opaque
- geracao_imagem.background_aliases.auto: auto
- geracao_imagem.background_aliases.transparent: transparent
- geracao_imagem.background_aliases.transparente: transparent
- geracao_imagem.background_aliases.opaque: opaque
- geracao_imagem.background_aliases.opaco: opaque
- geracao_imagem.background_aliases.opaca: opaque
- geracao_imagem.flag_aliases.size: --size, --tamanho
- geracao_imagem.flag_aliases.quality: --quality, --qualidade
- geracao_imagem.flag_aliases.format: --format, --formato
- geracao_imagem.flag_aliases.background: --background, --fundo
- geracao_imagem.flag_aliases.compression: --compression, --compressao, --compressão
- geracao_imagem.compression.min: 0
- geracao_imagem.compression.max: 100
- observabilidade:
- event_name: command.executed
- analytics_event: whatsapp_command_catimg
- tags_log: whatsapp, command, aiModule, catimg
- nivel_log: info
- privacidade:
- dados_sensiveis:
- chat_identifier
- sender_identifier
- command_content
- retencao: standard_app_logs
- base_legal: service_execution_and_legitimate_interest
- docs:
- summary: Gera/edita imagem com IA por prompt.
- usage_examples: <prefix>iaimagem seu prompt, <prefix>iaimagem --size 1536x1024 seu prompt
- usage_variants.default: _<prefix>iaimagem_ seu prompt, _<prefix>iaimagem_ (responda uma imagem com legenda para editar), , Opções:, --size 1024x1024 | 1024x1536 | 1536x1024 | auto, --quality low | medium | high | auto, --format png | jpeg | webp, --background transparent | opaque | auto, --compression 0-100, , Exemplo:, _<prefix>iaimagem_ --size 1536x1024 Um gato astronauta em aquarela.
- behavior:
- type: argument_driven
- allowed_actions: (nenhum)
- limits:
- usage_description: imagem de entrada ate OPENAI_MAX_IMAGE_MB (padrao 50 MB)
- rate_limit.max: null
- rate_limit.janela_ms: null
- rate_limit.escopo: sem_rate_limit_explicito
- access.somente_premium: true
- access.planos_permitidos: premium
- plan_limits.comum.max: 8
- plan_limits.comum.janela_ms: 300000
- plan_limits.comum.escopo: usuario
- plan_limits.premium.max: 40
- plan_limits.premium.janela_ms: 300000
- plan_limits.premium.escopo: usuario
- discovery:
- keywords: iaimagem, catimage, ia, privado, grupo
- faq_queries: como usar iaimagem, o que faz iaimagem, comando iaimagem
- user_phrasings: quero usar iaimagem, me ajuda com iaimagem, gera/edita imagem com ia
- suggestion_priority: 100
- handler:
- file: catCommand.js
- method: handleCatImageCommand
- command_case: iaimagem

### pergunteia

- id: ai.pergunteia
- aliases: iaprompt, promptia, catprompt
- enabled: true
- categoria: ia
- descricao: Define ou reseta o prompt personalizado da IA para o usuario.
- permissao_necessaria: usuario comum
- version: 1.0.0
- stability: stable
- deprecated: nao
- risk_level: low
- local_de_uso:
- privado
- grupo
- metodos_de_uso:
- <prefix>pergunteia novo prompt
- <prefix>pergunteia reset
- mensagens_uso (variantes):
- default:
- _<prefix>pergunteia_ seu novo prompt
- Para voltar ao padrão:
- _<prefix>pergunteia reset_
- subcomandos:
- reset
- argumentos:
- conteudo | tipo: string | obrigatorio | validacao: texto do prompt ou reset | default: null | posicao: 0
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
- comum: max=8, janela_ms=300000, escopo=usuario
- premium: max=40, janela_ms=300000, escopo=usuario
- informacoes_coletadas:
- identificador do chat (remoteJid)
- identificador do remetente (senderJid)
- texto do comando e argumentos
- contexto da mensagem (citacao e mencoes, quando existir)
- prompt personalizado informado pelo usuario
- identidade do usuario para salvar/atualizar preferencia
- dependencias_externas:
- store interno de prompt de IA
- efeitos_colaterais:
- salva ou reseta prompt personalizado do usuário
- respostas_padrao:
- success: Comando executado com sucesso.
- usage_error: Formato de uso inválido. Consulte metodos_de_uso.
- permission_error: Permissão insuficiente para executar este comando.
- sucesso: Comando executado com sucesso.
- erro_uso: Formato de uso inválido. Consulte metodos_de_uso.
- erro_permissao: Permissão insuficiente para executar este comando.
- mensagens_sistema:
- premium_only: ⭐ _Comando Premium_

Este comando é exclusivo para usuários premium.
Fale com o administrador para liberar o acesso.

- prompt_muito_longo: ⚠️ Prompt muito longo. Limite: {{max_chars}} caracteres.
- prompt_reset_sucesso: ✅ Prompt da IA restaurado para o padrão.
- prompt_update_sucesso: ✅ Prompt da IA atualizado para você.
- usage_header: 🧠 _Prompt da IA_
- limites_operacionais:
- prompt_max_chars: 2000
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
- parse.reset_aliases: reset, default, padrao, padrão
- observabilidade:
- event_name: command.executed
- analytics_event: whatsapp_command_catprompt
- tags_log: whatsapp, command, aiModule, catprompt
- nivel_log: info
- privacidade:
- dados_sensiveis:
- sender_identifier
- command_content
- retencao: standard_app_logs
- base_legal: service_execution_and_legitimate_interest
- docs:
- summary: Define ou reseta o prompt personalizado da IA para o usuario.
- usage_examples: <prefix>pergunteia novo prompt, <prefix>pergunteia reset
- usage_variants.default: _<prefix>pergunteia_ seu novo prompt, , Para voltar ao padrão:, _<prefix>pergunteia reset_
- behavior:
- type: subcommand
- allowed_actions: reset
- limits:
- usage_description: 1 prompt por usuario (atualizavel)
- rate_limit.max: null
- rate_limit.janela_ms: null
- rate_limit.escopo: sem_rate_limit_explicito
- access.somente_premium: false
- access.planos_permitidos: comum, premium
- plan_limits.comum.max: 8
- plan_limits.comum.janela_ms: 300000
- plan_limits.comum.escopo: usuario
- plan_limits.premium.max: 40
- plan_limits.premium.janela_ms: 300000
- plan_limits.premium.escopo: usuario
- discovery:
- keywords: pergunteia, iaprompt, promptia, ia, privado, grupo
- faq_queries: como usar pergunteia, o que faz pergunteia, comando pergunteia
- user_phrasings: quero usar pergunteia, me ajuda com pergunteia, define ou reseta o
- suggestion_priority: 100
- handler:
- file: catCommand.js
- method: handleCatPromptCommand
- command_case: pergunteia
