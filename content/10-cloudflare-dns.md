---
title: Cloudflare DNS
order: 10
---

# Cloudflare — DNS

O domínio `evalabs.com.br` está na Cloudflare; o lab usa um
subdomínio (`lab.evalabs.com.br`) com um registro **wildcard**, então
qualquer nome novo (`grafana.lab...`, `nomad.lab...`, `orders.lab...`)
já resolve sem precisar criar registro um a um.

## Como está neste lab

- Registro: `*.lab.evalabs.com.br` → IP público da **Load Balancer** da
  Azure (não de uma VM específica — é a LB quem distribui pros
  workers).
- Modo **"Somente DNS"** (nuvem cinza, proxy da Cloudflare desligado) —
  a Cloudflare só resolve o nome; a conexão HTTP vai direto do
  navegador pro IP da Azure, sem passar pelo edge/CDN da Cloudflare.
  Isso significa que **não há terminação TLS real via Cloudflare** neste
  lab hoje (ver a observação sobre o entrypoint `websecure` do Traefik
  em [Traefik](06-traefik)) — o acesso é HTTP puro na prática.
- Também existe um registro dedicado pro Harbor,
  `registry.lab.evalabs.com.br`, apontando pro IP público da VM do
  registry (não pela LB, já que o registry não tem réplicas).

## Fazendo manualmente

Criar um registro wildcard via API da Cloudflare (o equivalente do que
se faz na tela "DNS" do painel):

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "A",
    "name": "*.lab",
    "content": "20.12.78.47",
    "proxied": false,
    "ttl": 1
  }'
```

Descobrir o `ZONE_ID` de um domínio:

```bash
curl -s "https://api.cloudflare.com/client/v4/zones?name=evalabs.com.br" \
  -H "Authorization: Bearer <API_TOKEN>" | jq -r '.result[0].id'
```

Conferir a resolução (o comando mais usado pra depurar DNS neste lab):

```bash
dig +short grafana.lab.evalabs.com.br
# ou, se "dig" não estiver disponível:
python3 -c "import socket; print(socket.gethostbyname('grafana.lab.evalabs.com.br'))"
```

Testar se o problema é DNS ou é o servidor de origem — apontando
direto pro IP em vez de confiar na resolução (técnica usada bastante
neste lab pra isolar onde uma falha realmente está):

```bash
curl -H "Host: grafana.lab.evalabs.com.br" http://20.12.78.47/
```

Se esse `curl` funciona mas o nome de domínio não, o problema é DNS (o
registro não existe, está errado, ou ainda não propagou). Se os dois
falham do mesmo jeito, o problema está no Traefik/aplicação, não na
Cloudflare.
