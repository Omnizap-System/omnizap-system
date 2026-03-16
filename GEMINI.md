# Omnizap - GEMINI.md

Este arquivo fornece contexto e diretrizes para o Gemini CLI operar com segurança e eficiência no projeto **Omnizap**.

## Visão Geral do Projeto

O **Omnizap** é um sistema profissional de automação para WhatsApp, integrando um bot robusto, painel web de gerenciamento, catálogo de figurinhas (stickers) com classificação por IA e um sistema de RPG (Pokemon) integrado.

- **Arquitetura:** Monolito modular em Node.js (ESM).
- **Core Engine:** `@whiskeysockets/baileys` para conectividade WhatsApp.
- **Backend:** Servidor HTTP customizado (Node.js nativo + roteamento modular), MySQL para persistência.
- **Frontend:** Single Page Applications (SPAs) em React, estilizadas com TailwindCSS e DaisyUI.
- **Observabilidade:** Métricas via Prometheus, logs estruturados com `pino`.
- **IA:** Integração com Gemini e OpenAI para suporte, classificação de stickers e aprendizado de padrões.

## Estrutura do Repositório

- `index.js`: Ponto de entrada (bootstrap) que inicializa banco, servidor HTTP e conexão WhatsApp.
- `app/`: Lógica de domínio do bot e serviços.
  - `connection/`: Gerenciamento do socket Baileys e estado de autenticação.
  - `controllers/`: Pipeline de processamento de mensagens.
  - `modules/`: Módulos funcionais (AI, RPG, StickerPack, Admin, etc.).
  - `services/`: Serviços de infraestrutura e integração externa.
- `server/`: Servidor HTTP, rotas, middlewares e controladores de API.
- `database/`: Schema consolidado (`schema.sql`) e script de inicialização (`init.js`).
- `public/`: Código-fonte do frontend (React) e assets estáticos.
- `scripts/`: Utilitários para build, deploy, release e tarefas de background.
- `docs/`: Documentação técnica, manuais de operação e conformidade.

## Comandos Principais

### Desenvolvimento

- `npm install`: Instala as dependências.
- `cp .env.example .env`: Configura as variáveis de ambiente necessárias.
- `npm run db:init`: Inicializa o banco de dados MySQL e aplica o schema.
- `npm run dev`: Inicia o sistema em modo de desenvolvimento.

### Build e Qualidade

- `npm run build:frontend`: Gera os bundles de produção para o frontend (CSS + JS via Vite).
- `npm run check`: Executa linting, testes e checagem de formatação.
- `npm test`: Roda a suíte de testes (Node.js native test runner).
- `npm run lint`: Executa o ESLint.
- `npm run format`: Aplica a formatação do Prettier.

### Segurança e Manutenção

- `npm run security:audit`: Executa auditoria de dependências (`npm audit`).
- `npm run security:codeql`: Roda análise estática localmente.
- `npm run catalog:commands`: Gera o catálogo de comandos para os módulos.

## Convenções de Desenvolvimento

- **Módulos:** Utilize estritamente ES Modules (`import`/`export`).
- **Imports:** Use subpath imports definidos no `package.json` (`#logger`, `#time`).
- **Logging:** Utilize o módulo `#logger` (Pino) para logs estruturados. Evite `console.log`.
- **Banco de Dados:** Utilize o pool de conexões do MySQL em `database/index.js`. Novos campos devem ser refletidos no `database/schema.sql`.
- **Frontend:** Novos componentes devem seguir o padrão React + TailwindCSS.
- **Segurança:** Nunca exponha segredos ou dados sensíveis em logs ou no código. Use variáveis de ambiente.

## Observações de Segurança

O projeto possui fluxos de CI para CodeQL e Gitleaks. Auditorias de dependência devem ser realizadas regularmente. O sistema utiliza `helmet` e `express-rate-limit` (no backend) para proteção contra ataques comuns.
