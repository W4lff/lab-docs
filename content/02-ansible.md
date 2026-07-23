---
title: Ansible
order: 2
---

# Ansible

Regra de ouro deste lab, que vale repetir porque é fácil de confundir:
**Ansible configura máquina, nunca sobe container de aplicação.** Ele
instala Docker, instala os binários do Consul/Nomad/Vault e escreve os
arquivos de config deles (`.hcl`), inicializa e faz unseal do Vault.
Quem sobe/atualiza aplicações é sempre o **GitHub Actions** rodando
`nomad job run` (ver [GitHub Actions](08-github-actions)).

## Como está neste lab

- `ansible/inventory.tpl` — gerado pelo Terraform (`templatefile()`) a
  partir dos IPs reais das VMs recém-criadas. Grupos: `control_plane`,
  `workers`, `registry`, `monitoring`, com grupos compostos
  (`docker_hosts:children` = todo mundo; `nomad_clients:children` =
  `workers` + `monitoring`).
- `playbook.yml` — instala Docker Engine em todo `docker_host`, e
  configura `insecure-registries` no `daemon.json` apontando pro Harbor
  (que não tem certificado TLS válido, só uso interno). O handler que
  aplica essa mudança usa `reload docker` (SIGHUP), **não** `restart
  docker` — motivo: um `restart` do daemon mata todo container rodando
  sem política de restart (os runners do GitHub Actions, por exemplo),
  e `insecure-registries` é uma config que o daemon recarrega a quente.
- `cluster.yml` — o playbook principal, em 5 plays:
  1. Instala os binários HashiCorp (`consul`, `nomad`, `vault`) em
     `control_plane` + `nomad_clients`.
  2. Configura Consul+Nomad+Vault como **servers** nas 3 VMs de
     `control_plane` (escreve os `.hcl`, sobe os `systemd services`,
     registra manualmente os serviços `vault-ui` e `nomad-ui` no
     catálogo do Consul — eles não se auto-registram com as tags de
     Traefik que a gente precisa).
  3. Configura Consul+Nomad como **clients** em `nomad_clients` (workers
     + monitoring).
  4. Inicializa o Vault (`vault operator init`) — só roda uma vez, no
     primeiro control-plane; as chaves de unseal e o root token são
     salvos **fora do repo** (`.vault-init.json`, no `.gitignore`).
  5. Faz `vault operator raft join` + `vault operator unseal` em todos
     os control-planes (os outros 2 entram no Raft e desbloqueiam com as
     mesmas chaves).
- `group_vars/control_plane.yml` — gitignored, guarda o
  `nomad_vault_token` (token clássico que o Nomad ainda exige configurar
  no server pra habilitar a feature de Vault, mesmo autenticando as
  tasks via workload identity na prática — ver [Nomad](04-nomad)).
- Disparo: um `null_resource` no Terraform (`configure.tf`) roda
  `./ansible/run.sh` sempre que o hash do inventário ou dos templates
  muda — não a cada `apply`, só quando algo relevante de fato mudou.

## Fazendo manualmente (sem Ansible)

Instalar e subir um Consul client à mão, numa VM Ubuntu:

```bash
# Repositório oficial da HashiCorp
curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo apt-key add -
sudo apt-add-repository "deb [arch=amd64] https://apt.releases.hashicorp.com \
  $(lsb_release -cs) main"
sudo apt update && sudo apt install -y consul nomad vault

# Config do Consul client
sudo tee /etc/consul.d/consul.hcl <<'EOF'
datacenter     = "dc1"
data_dir       = "/opt/consul"
server         = false
bind_addr      = "10.20.2.10"
client_addr    = "0.0.0.0"
advertise_addr = "10.20.2.10"
encrypt        = "CHAVE_GERADA_COM_consul_keygen"
retry_join     = ["10.20.1.10", "10.20.1.11", "10.20.1.12"]
EOF

sudo systemctl enable --now consul
consul members   # confirma que entrou no cluster
```

Gerar a chave de encrypt do gossip (o que o Terraform faz com
`random_id` neste lab):

```bash
consul keygen
```

Docker com registry inseguro configurado à mão:

```bash
sudo tee /etc/docker/daemon.json <<'EOF'
{ "insecure-registries": ["registry.lab.evalabs.com.br"] }
EOF
sudo systemctl reload docker   # não "restart" — não derruba containers rodando
```

A diferença prática de fazer isso via Ansible: **idempotência**
(rodar de novo não quebra nada que já está certo) e o playbook documenta,
em texto, exatamente o que foi feito em cada VM — não depende de
lembrar qual comando rodou em qual máquina há 3 meses.
