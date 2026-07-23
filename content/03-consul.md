---
title: Consul
order: 3
---

# Consul

Consul é o "catálogo telefônico" do cluster: todo serviço que sobe se
registra nele (nome, IP, porta, tags), e quem precisa achar outro
serviço pergunta pro Consul em vez de usar IP fixo no código.

## Como está neste lab

- 3 servers (`control_plane`, `bootstrap_expect = 3`) + 3 clients
  (2 workers + 1 monitoring). `datacenter = "dc1"`.
- Gossip protocol **criptografado** (`encrypt = "<chave>"`, gerada uma
  vez com `consul keygen` e guardada como `random_id` no Terraform) —
  sem isso, qualquer VM na mesma rede poderia entrar no cluster Consul.
- **Sem ACLs habilitadas** — qualquer agente que conheça a chave de
  gossip e os IPs dos servers entra no cluster e pode registrar/consultar
  serviços livremente. Aceitável neste lab (rede isolada, propósito de
  aprendizado); num ambiente real, `acl { enabled = true }` + tokens por
  serviço seria o próximo passo.
- UI habilitada (`ui_config { enabled = true }`), acessível hoje só via
  IP privado — não tem rota pública dedicada (diferente do Vault UI e
  Nomad UI, que foram expostos deliberadamente via Traefik+SSO).
- A maioria dos serviços se registra **sozinha**, via o bloco `service{}`
  dentro do próprio job Nomad (é o Nomad quem fala com o Consul local por
  trás dos panos). Duas exceções que precisaram de registro **manual**
  (arquivo `.hcl` direto em `/etc/consul.d/`, aplicado pelo Ansible):
  `vault-ui` e `nomad-ui` — porque Vault e Nomad têm seu próprio
  mecanismo de "estou vivo" e não aceitam tags arbitrárias de Traefik
  como um job Nomad aceitaria.
- O Traefik usa o provider `consulcatalog`: ele fica de olho no catálogo
  do Consul e monta as rotas HTTP dinamicamente a partir das tags
  `traefik.*` de cada serviço registrado — nenhuma rota é escrita à mão
  num arquivo de config do Traefik.

## Fazendo manualmente

Registrar um serviço sem passar pelo Nomad, direto na API HTTP do
Consul local:

```bash
curl -X PUT http://127.0.0.1:8500/v1/agent/service/register -d '{
  "Name": "meu-servico",
  "Port": 8080,
  "Tags": [
    "traefik.enable=true",
    "traefik.http.routers.meu.rule=Host(`meu.lab.evalabs.com.br`)"
  ],
  "Check": {
    "HTTP": "http://127.0.0.1:8080/healthz",
    "Interval": "10s"
  }
}'
```

Consultar o catálogo (o que o Traefik faz constantemente por trás dos
panos):

```bash
curl -s http://127.0.0.1:8500/v1/catalog/services | jq
curl -s http://127.0.0.1:8500/v1/catalog/service/meu-servico | jq
```

Ver membros do cluster gossip e status de saúde:

```bash
consul members
consul catalog services
consul catalog nodes
```

Remover um registro manual:

```bash
curl -X PUT http://127.0.0.1:8500/v1/agent/service/deregister/meu-servico
```

A diferença de fazer isso "na mão" pra um job Nomad: o job Nomad já
cuida do registro/de-registro automaticamente (sobe → registra, cai →
remove), enquanto um registro manual via `curl` fica órfão se o
processo cair sem chamar o `deregister` — por isso os únicos dois casos
manuais no lab (`vault-ui`, `nomad-ui`) são serviços que o Ansible
mantém, não que sobem/descem com frequência.
