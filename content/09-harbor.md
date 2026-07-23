---
title: Harbor (registry)
order: 9
---

# Harbor — registry de imagens

Harbor guarda as imagens Docker que o próprio lab constrói (loja, blog,
tasks-api, tasks-front, lab-docs). Imagens públicas (Prometheus, Vault,
Grafana etc.) vêm direto do Docker Hub — só o que é construído *neste*
lab passa pelo Harbor.

## Como está neste lab

- VM dedicada (`vm-registry-01`, sub-rede própria `10.20.3.0/24`) — não
  divide host com aplicações, pelo mesmo motivo do monitoring: um
  problema de disco/CPU no registry não pode derrubar apps já rodando
  (elas só falam com o Harbor no momento do `docker push`/`docker pull`,
  não continuamente).
- Instalado via o instalador oficial do próprio Harbor (`install.sh`),
  não um job Nomad — o Harbor é infraestrutura de suporte ao cluster,
  não uma aplicação do cluster.
- Sem certificado TLS válido (`registry.lab.evalabs.com.br` resolve pro
  IP dessa VM, sem HTTPS de verdade) — por isso todo Docker daemon do
  lab precisa ter essa entrada em `insecure-registries` (configurado via
  Ansible, ver [Ansible](02-ansible)); sem isso, `docker push`/`pull`
  falham com erro de TLS.
- O runner do GitHub Actions de cada app faz `docker login` no Harbor
  usando uma senha guardada como **GitHub Secret** (`HARBOR_PASSWORD`),
  nunca em texto no repo.
- Projeto usado: `library` (padrão do Harbor) — imagens ficam em
  `registry.lab.evalabs.com.br/library/<nome-da-imagem>`.

## Fazendo manualmente

Instalar o Harbor (resumo do que o instalador oficial faz):

```bash
wget https://github.com/goharbor/harbor/releases/download/v2.11.0/harbor-online-installer-v2.11.0.tgz
tar xzf harbor-online-installer-v2.11.0.tgz
cd harbor
cp harbor.yml.tmpl harbor.yml
# editar harbor.yml: hostname = registry.lab.evalabs.com.br, desabilitar https
sudo ./install.sh
```

Configurar um Docker client pra confiar num registry sem TLS válido (o
que o Ansible faz em toda VM do lab):

```bash
sudo tee /etc/docker/daemon.json <<'EOF'
{ "insecure-registries": ["registry.lab.evalabs.com.br"] }
EOF
sudo systemctl reload docker
```

Login, build, push e pull manuais (o que o pipeline de CI automatiza):

```bash
docker login registry.lab.evalabs.com.br -u admin -p <senha>

docker build -t registry.lab.evalabs.com.br/library/minha-app:v1 .
docker push registry.lab.evalabs.com.br/library/minha-app:v1

docker pull registry.lab.evalabs.com.br/library/minha-app:v1
```

Usar essa imagem num job Nomad:

```hcl
config {
  image = "registry.lab.evalabs.com.br/library/minha-app:v1"
}
```
