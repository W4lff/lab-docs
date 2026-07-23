---
title: Terraform + Azure
order: 1
---

# Terraform + Azure

Terraform é quem cria a infraestrutura crua: VNet, sub-redes, NSGs
(firewall), e as VMs. Ele **não** instala software nenhum dentro das
VMs — isso é trabalho do Ansible (chamado a partir de um
`null_resource` no próprio Terraform, ver [Ansible](02-ansible)).

## Como está neste lab

- Providers: `azurerm`, `random` (gera as chaves de encrypt do Consul e
  Nomad), `local` (escreve o inventário do Ansible), `null` (dispara o
  Ansible depois que as VMs existem).
- Um **módulo reutilizável e versionado**, publicado como repo Git
  próprio (`terraform-vms-azure`, tag `v0.2.0`), usado 4 vezes:

  ```hcl
  module "control_plane" {
    source = "git@github.com:W4lff/terraform-vms-azure.git?ref=v0.2.0"
    count  = 3
    name   = "vm-control-0${count.index + 1}"
    subnet_id = azurerm_subnet.control_plane.id
    vm_size   = "Standard_B2s"
    # ...
  }
  ```

  O mesmo módulo é reaproveitado pra `data_plane` (2 VMs), `registry` (1
  VM) e `monitoring` (1 VM) — só muda a sub-rede e a contagem. Versionar
  o módulo com tag Git (em vez de apontar pro branch `main`) evita que
  uma mudança no módulo quebre um `apply` antigo sem querer.
- Rede: uma VNet `10.20.0.0/16` com 4 sub-redes (ver
  [Arquitetura](00-arquitetura)), cada uma com sua própria
  `azurerm_subnet_network_security_group_association`.
- NSGs (Network Security Groups) — as regras mais importantes:
  - SSH (porta 22): só do IP de casa.
  - Web (80/443): do IP de casa **e** dos IPs públicos de todas as VMs do
    lab. Isso existe por um detalhe não-óbvio: tráfego VM→VM que passa
    pelo **IP público** de outra VM (em vez do IP privado) é avaliado
    pela Azure com a tag de origem `Internet`, não `VirtualNetwork` — sem
    essa regra, esse tráfego seria bloqueado mesmo as duas VMs estando na
    mesma rede.
  - `AllowClusterTcpWithinVNet`: portas 4646-4648 (Nomad), 8200 (Vault),
    8300-8302 (Consul RPC/gossip TCP), 8500 (Consul HTTP), 8600 (Consul
    DNS) — só entre `VirtualNetwork` (não precisa listar IP nenhum, esse
    tráfego já é IP privado→IP privado).
  - `AllowClusterUdpWithinVNet`: gossip do Consul (8301-8302 UDP) + DNS
    (8600 UDP).
- Outputs: IPs públicos/privados de cada grupo de VM, IP da Load
  Balancer, e comandos `ssh` prontos (`ssh_commands`).

## Fazendo manualmente (sem Terraform)

Criar o equivalente de uma VM do `data_plane` à mão via `az cli`:

```bash
# Resource group + VNet (uma vez só)
az group create -n rg-lab -l eastus2
az network vnet create -g rg-lab -n vnet-lab --address-prefix 10.20.0.0/16 \
  --subnet-name snet-data-plane --subnet-prefix 10.20.2.0/24

# NSG com as mesmas regras
az network nsg create -g rg-lab -n nsg-lab
az network nsg rule create -g rg-lab --nsg-name nsg-lab -n AllowSSH \
  --priority 100 --destination-port-ranges 22 --access Allow \
  --source-address-prefixes SEU_IP/32

az network nsg rule create -g rg-lab --nsg-name nsg-lab -n AllowClusterTcp \
  --priority 200 --destination-port-ranges 4646-4648 8200 8300-8302 8500 8600 \
  --source-address-prefixes VirtualNetwork --access Allow --protocol Tcp

# Associar a NSG à sub-rede
az network vnet subnet update -g rg-lab --vnet-name vnet-lab \
  -n snet-data-plane --network-security-group nsg-lab

# A VM em si
az vm create -g rg-lab -n vm-worker-01 \
  --image Ubuntu2204 --size Standard_B2s \
  --vnet-name vnet-lab --subnet snet-data-plane \
  --admin-username azureuser --ssh-key-values ~/.ssh/id_rsa.pub \
  --public-ip-sku Standard
```

Pra Load Balancer manual (o pedaço mais tedioso à mão):

```bash
az network public-ip create -g rg-lab -n pip-lb --sku Standard
az network lb create -g rg-lab -n lb-ingress --sku Standard \
  --public-ip-address pip-lb --frontend-ip-name feip --backend-pool-name bepool
az network lb probe create -g rg-lab --lb-name lb-ingress -n http-probe \
  --protocol Tcp --port 80
az network lb rule create -g rg-lab --lb-name lb-ingress -n http-rule \
  --protocol Tcp --frontend-port 80 --backend-port 80 \
  --frontend-ip-name feip --backend-pool-name bepool --probe-name http-probe
# depois: associar as NICs dos 2 workers ao backend pool bepool
```

O valor do Terraform aqui não é "fazer algo impossível à mão" — é
**repetir isso de forma idêntica e sem erro de digitação** toda vez que
o cluster precisa ser recriado, e versionar a infra como código (git
log = histórico de toda mudança de infraestrutura).
