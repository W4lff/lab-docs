---
title: Vault
order: 5
---

# Vault

Vault é o cofre de segredos do lab: senha de banco, chave de API,
senha do admin do Grafana — nada disso está em texto em nenhum
repositório. Toda aplicação busca o valor em tempo de execução.

## Como está neste lab

- **Storage: Raft integrado** (não Consul storage backend) — os 3
  control-planes formam o próprio cluster Raft do Vault, independente do
  cluster Raft do Nomad.
  ```hcl
  storage "raft" {
    path    = "/opt/vault/data"
    node_id = "vm-control-01"
    retry_join { leader_api_addr = "http://10.20.1.11:8200" }
    retry_join { leader_api_addr = "http://10.20.1.12:8200" }
  }
  ```
- **TLS desabilitado no listener** (`tls_disable = true`) — tráfego HTTP
  puro entre os componentes do lab, aceitável porque toda comunicação
  fica dentro da VNet privada, nunca exposta direto à internet (o Vault
  UI é exposto via Traefik+SSO, não direto).
- **Init/unseal**: rodou uma vez só (`vault operator init`), gerando 5
  chaves de unseal (limiar 3) + 1 root token — guardados **fora do
  repo**, em `.vault-init.json` (gitignored). Os outros 2 control-planes
  entram no Raft (`vault operator raft join`) e são desbloqueados
  (`vault operator unseal`) com as mesmas chaves.
- **HA ativo-standby com forwarding**: só 1 nó é líder por vez; os
  outros 2 ficam em standby e **encaminham** requisições pro líder — por
  isso um job Nomad pode apontar pro IP de *qualquer* control-plane no
  `vault { address = ... }` e funciona mesmo se aquele nó específico não
  for o líder no momento.
- **KV v2** montado em `secret/` — cada app tem seu próprio caminho
  (`secret/data/ecommerce-demo`, `secret/data/blog`, `secret/data/tasks`,
  `secret/data/grafana`).
- **Auth method JWT**, path fixo `jwt-nomad` (não é configurável por
  escolha — é o path que a integração workload-identity do Nomad espera
  encontrar):
  ```bash
  vault auth enable -path=jwt-nomad jwt
  vault write auth/jwt-nomad/config \
    jwks_url="http://10.20.1.10:4646/.well-known/jwks.json" \
    bound_issuer="https://10.20.1.10:4646/"
  ```
  Cada app tem uma **role** JWT própria, restrita ao seu `job_id`:
  ```bash
  vault write auth/jwt-nomad/role/nomad-loja \
    role_type="jwt" \
    bound_audiences="vault.io" \
    bound_claims='{"nomad_job_id":"loja"}' \
    user_claim="nomad_job_id" \
    policies="ecommerce-demo" \
    ttl=1h
  ```
- **OIDC habilitado também** (auth method separado do JWT acima) — usado
  pra login humano no Vault UI via Keycloak/SSO, não pelas aplicações.
- **Telemetria Prometheus** habilitada sem exigir token
  (`unauthenticated_metrics_access = true` no listener) — só métricas
  operacionais (latência, throughput), nenhum dado de secret.

## Fazendo manualmente

Subir um Vault dev (auto-unseal, um nó só, só pra testar):

```bash
vault server -dev -dev-root-token-id=root
export VAULT_ADDR=http://127.0.0.1:8200
export VAULT_TOKEN=root
```

Inicializar e desbloquear um Vault de verdade (o que o Ansible faz uma
vez só):

```bash
vault operator init -key-shares=5 -key-threshold=3
# guarda as 5 unseal keys + o root token em lugar seguro, NUNCA no repo

vault operator unseal   # roda 3x, uma por chave
```

Escrever e ler um segredo (KV v2):

```bash
vault kv put secret/minha-app usuario=admin senha=trocar123
vault kv get secret/minha-app
vault kv get -field=senha secret/minha-app
```

Criar uma policy restrita a esse segredo:

```bash
vault policy write minha-app - <<EOF
path "secret/data/minha-app" {
  capabilities = ["read"]
}
EOF
```

Habilitar JWT auth e criar uma role (o que dá pra qualquer job Nomad ler
aquele segredo, via workload identity):

```bash
vault auth enable -path=jwt-nomad jwt
vault write auth/jwt-nomad/config jwks_url="http://<nomad>:4646/.well-known/jwks.json"
vault write auth/jwt-nomad/role/minha-role \
  role_type=jwt bound_audiences="vault.io" \
  bound_claims='{"nomad_job_id":"minha-app"}' \
  user_claim="nomad_job_id" policies="minha-app" ttl=1h
```

Testar autenticação manualmente com um token de teste (fora do fluxo
automático do Nomad):

```bash
vault write auth/jwt-nomad/login role=minha-role jwt=<token-jwt>
```
