# Guará Play — colocar o servidor no ar a partir do notebook

Este guia leva o servidor do seu notebook (Ubuntu) para a internet, com endereço fixo e HTTPS, para acessar de qualquer lugar e atender os clientes.

## Antes de começar (5 minutos)

**1. A internet da casa tem IP público?**
- No notebook, abra `https://api.ipify.org` e anote o número.
- Entre no painel do roteador (costuma ser `192.168.1.1`) e procure o IP da WAN/Internet.
- Se forem **iguais**, ótimo. Se forem **diferentes**, a operadora usa CGNAT: peça um IP público à operadora ou use uma VPS (cerca de 6 € por mês). Sem isso, o acesso de fora não funciona.

**2. O notebook não pode dormir.**
```
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
```
Deixe o notebook na tomada e, de preferência, no cabo de rede.

## Passo 1 — endereço gratuito (DuckDNS)

1. Entre em **duckdns.org** com a conta Google.
2. Crie um nome, por exemplo `guaraplay` (vira `guaraplay.duckdns.org`).
3. Copie o **token** que aparece no topo da página.
4. No campo *current ip*, digite o IP público da casa e clique em *update ip*.

Para o IP ser atualizado sozinho quando mudar, rode `crontab -e` e adicione (troque o nome e o token):
```
*/5 * * * * curl -s "https://www.duckdns.org/update?domains=guaraplay&token=SEU_TOKEN&ip=" >/dev/null
```

## Passo 2 — IP fixo para o notebook

No roteador, faça uma **reserva de DHCP** para o notebook (use o MAC dele). Assim o IP interno não muda.

## Passo 3 — abrir as portas no roteador

Crie dois redirecionamentos (port forwarding) apontando para o IP interno do notebook:
- TCP **80** → 80
- TCP **443** → 443

O Caddy precisa das duas para obter o certificado HTTPS.

## Passo 4 — instalar o servidor

Copie a pasta do projeto para `/opt/signage` e rode o instalador (sem `sudo` na frente do `bash`):
```
sudo mkdir -p /opt/signage && sudo rsync -a --exclude android --exclude .git --exclude node_modules ./ /opt/signage/
cd /opt/signage
DOMAIN=guaraplay.duckdns.org ADMIN_PASS='uma-senha-forte' bash setup-server.sh
```
O script instala o Node, o Caddy (HTTPS automático) e o serviço `guara`, que reinicia sozinho se cair.

Se você já tem cadastro no notebook, copie também `data.json`, `stats.json` e a pasta `media/` de `~/signage` para `/opt/signage` **antes** de iniciar, ou use o `restore.sh` com um backup.

## Passo 5 — testar

- No notebook: `https://guaraplay.duckdns.org` deve abrir o painel com cadeado.
- Num celular **com o Wi-Fi desligado** (dados móveis): `https://guaraplay.duckdns.org/player.html` deve mostrar um código de 6 dígitos.

Se o cadeado não aparecer, espere 2 minutos e tente de novo. Se continuar, confira as portas 80 e 443 no roteador.

## Passo 6 — apontar as TVs

Em cada aparelho: **Voltar 5 vezes**, digite o PIN, escolha trocar o servidor e digite `https://guaraplay.duckdns.org`. Não precisa recompilar o APK.

## Backup (obrigatório para atender clientes)

Os dados ficam em `/opt/signage`: `data.json` (cadastro), `stats.json` (relatórios) e `media/` (arquivos).

- Fazer backup agora: `bash /opt/signage/backup.sh` (guarda em `~/backups-guara`, mantém os últimos 14).
- Agendar todo dia às 3h: `crontab -e` e adicione
  `0 3 * * * bash /opt/signage/backup.sh >> $HOME/backups-guara/log.txt 2>&1`
- Restaurar: `bash /opt/signage/restore.sh ~/backups-guara/guara-AAAA-MM-DD_HHMMSS.tar.gz`
- Copie os backups para outro lugar (pendrive, HD externo ou Drive) pelo menos uma vez por semana. Se o notebook quebrar, é o único jeito de recuperar.

## Comandos do dia a dia

- Ver se está rodando: `sudo systemctl status guara`
- Últimas linhas do log: `sudo journalctl -u guara -n 50`
- Reiniciar: `sudo systemctl restart guara`
- Atualizar o código: copie os arquivos novos para `/opt/signage` e rode `sudo systemctl restart guara`. O cadastro e os arquivos não são apagados.

## Cuidados antes de fechar contrato

- **Senha forte** no painel e nunca `1234`.
- **Backup** agendado e copiado para outro lugar.
- **Notebook em energia estável** (considere um nobreak).
- Se o cliente depender do sistema, um notebook sozinho é um único ponto de falha. Para escalar, o próximo passo é uma VPS, que roda 24 horas sem depender de casa.
