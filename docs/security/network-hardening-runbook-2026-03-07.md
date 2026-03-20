# Runbook de Hardening de Rede (Produção)

Data: 2026-03-07  
Escopo: reduzir superfície externa detectada em scan (`22`, `3001`, `8007`) e mitigar risco de DoS por conexões lentas.

## 1) Objetivo operacional

- manter externamente acessíveis apenas `22/tcp` (restrito por IP), `80/tcp` e `443/tcp`;
- impedir exposição pública direta de serviços internos (`3001`, `8007`);
- endurecer Nginx e SSH;
- validar remediação por `nmap` externo.

## 2) Fechar portas públicas desnecessárias

No host de produção:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow from <IP_ADMIN>/32 to any port 22 proto tcp
sudo ufw deny 3001/tcp
sudo ufw deny 8007/tcp
sudo ufw --force enable
sudo ufw status verbose
```

## 3) Bind local para serviços internos

### Node (OmniZap)

- usar `METRICS_HOST=127.0.0.1` no ambiente de produção;
- confirmar que o processo não escuta em `0.0.0.0` nas portas internas.

### Uvicorn (porta 8007)

Se houver serviço FastAPI/Uvicorn no host, ajustar para loopback:

```ini
ExecStart=/usr/bin/uvicorn app:app --host 127.0.0.1 --port 8007
```

Após ajuste:

```bash
sudo systemctl daemon-reload
sudo systemctl restart <servico-uvicorn>
sudo systemctl status <servico-uvicorn> --no-pager
```

## 4) Hardening do Nginx (mitigar slow HTTP / slowloris)

Criar `/etc/nginx/conf.d/omnizap-hardening.conf`:

```nginx
server_tokens off;
client_header_timeout 10s;
client_body_timeout 10s;
send_timeout 10s;
keepalive_timeout 15s;
reset_timedout_connection on;

limit_conn_zone $binary_remote_addr zone=conn_per_ip:10m;
limit_req_zone $binary_remote_addr zone=req_per_ip:10m rate=20r/s;
```

No `server` de produção, aplicar:

```nginx
limit_conn conn_per_ip 40;
limit_req zone=req_per_ip burst=60 nodelay;
```

Validar e recarregar:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 5) Hardening de SSH

Criar `/etc/ssh/sshd_config.d/omnizap-hardening.conf`:

```sshconfig
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
MaxAuthTries 3
LoginGraceTime 20
AllowTcpForwarding no
X11Forwarding no
```

Validar e reiniciar:

```bash
sudo sshd -t
sudo systemctl restart ssh
```

## 6) Atualizações de segurança do sistema

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt autoremove -y
```

Observação: resultados do `nmap --script vuln` são majoritariamente heurísticos por versão/CPE. A confirmação final deve seguir boletins do fornecedor (Ubuntu/Nginx/OpenSSH) e versão de pacote instalada.

## 7) Checklist de validação final

No host:

```bash
sudo ss -lntp | egrep ':22|:80|:443|:3001|:8007'
```

De máquina externa:

```bash
nmap -p 22,80,443,3001,8007 -sV omnizap.shop
```

Resultado esperado:

- `22`, `80`, `443` abertos;
- `3001` e `8007` filtrados/fechados externamente.

## 8) Hardening da superficie web estatica (ZAP issue #103)

Objetivo: eliminar soft-404 e alinhar headers de seguranca em rotas estaticas servidas direto pelo Nginx (`/`, `/comandos/`, `/login/`, etc.).

1. Publicar snippet de headers estaticos:

```bash
sudo install -D -m 0644 docs/security/omnizap-static-security-headers.conf /etc/nginx/snippets/omnizap-static-security-headers.conf
```

2. No `server { ... }` de producao, garantir que rotas proxy (`/api/`, `/stickers/`, `/data/`) venham antes do fallback estatico e aplicar:

```nginx
# Nao permitir dotfiles sensiveis
location ~* (^|/)\.(?!well-known/) {
  return 404;
}

# Fallback estatico sem soft-404 (nao retorna home para caminho inexistente)
location / {
  try_files $uri $uri/ =404;
  include /etc/nginx/snippets/omnizap-static-security-headers.conf;
}
```

3. Validar e recarregar:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

4. Validacao rapida manual:

```bash
curl -I https://omnizap.shop/
curl -I https://omnizap.shop/notice-and-takedown/
curl -I https://omnizap.shop/.env
curl -I https://omnizap.shop/__security_probe_nonexistent_omnizap__.txt
```

5. Validacao automatizada (repositorio):

```bash
npm run security:web-surface
```

Resultado esperado:

- rotas estaticas com `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Permissions-Policy`;
- `/.env` sem `200`;
- caminho inexistente sem fallback `200` para a home.

## Referências

- Nginx admin guide: https://nginx.org/en/docs/
- OpenSSH hardening guidelines: https://www.openssh.com/manual.html
- Ubuntu security notices: https://ubuntu.com/security/notices
- UFW docs: https://manpages.ubuntu.com/manpages/jammy/en/man8/ufw.8.html
