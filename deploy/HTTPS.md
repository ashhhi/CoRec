# Ubuntu：通过固定公网 IP 使用 HTTPS

不需要域名。使用 Let's Encrypt 的公网 IP 证书，浏览器可以直接访问 `https://你的公网IP`。证书有效期为 160 小时，必须保留自动续期。

以下命令在 Ubuntu 服务器的 **CoRec 项目根目录**执行。需要 Docker Compose **2.24.4 或更新版本**，以及 Certbot **5.4 或更新版本**。部署使用服务器的 80、443 端口；云安全组和系统防火墙都需要允许公网访问这两个 TCP 端口，且不能有其他服务占用它们。80 端口也用于后续续期，不能在申请后关闭。

## 1. 安装 Certbot

使用 Snap 安装当前稳定版，避免 Ubuntu 自带的旧版本不支持 IP 证书。已有 Snap 版 Certbot 时，使用 `sudo snap refresh certbot` 更新。

```bash
sudo apt-get update
sudo apt-get install -y snapd
sudo snap install --classic certbot
sudo /snap/bin/certbot --version
sudo install -d -m 755 /etc/letsencrypt /var/lib/corec-acme
```

若启用了 UFW，放行端口；同时在云厂商控制台放行 TCP 80、443：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## 2. 临时启动 HTTP，提供证书验证入口

首次还没有证书，先使用 HTTP 配置启动。该命令会构建并启动现有服务，不删除数据库卷。HTTPS 配置会将 Web 端口切换为 80、443，不再发布原来的 `APP_PORT`。

```bash
COREC_NGINX_CONFIG=./deploy/nginx.conf docker compose \
  -f docker-compose.yml -f docker-compose.https.yml up --build -d
```

此阶段 API 已启用安全 Cookie，请完成下一步后再登录。

## 3. 申请受信任的公网 IP 证书

将下面两个值换成真实的固定公网 IPv4 和联系邮箱。保持证书名 `corec-ip` 不变，Nginx 配置使用该路径。

```bash
sudo /snap/bin/certbot certonly \
  --non-interactive --agree-tos \
  --email '你的邮箱' \
  --cert-name corec-ip \
  --webroot --webroot-path /var/lib/corec-acme \
  --preferred-challenges http \
  --required-profile shortlived \
  --ip-address '你的固定公网IP'
```

如果验证失败，请先确认公网 IP 正确、80 端口可从公网访问，并查看 Certbot 的错误信息。不要在没有证书时切换到 HTTPS 配置。

## 4. 启用 HTTPS 和自动加载续期证书

确认没有设置或导出 `COREC_NGINX_CONFIG`（它只用于上面的临时命令），然后运行：

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
chmod +x deploy/reload-https.sh
sudo install -d /etc/letsencrypt/renewal-hooks/deploy
sudo ln -sfn -- "$(pwd)/deploy/reload-https.sh" \
  /etc/letsencrypt/renewal-hooks/deploy/corec-reload-https
```

现在访问 **`https://你的固定公网IP`**，无需附加端口。HTTP 会跳转到 HTTPS，需要重新登录一次。HTTPS Compose 配置会自动设置 `COOKIE_SECURE=true`，无需改 `.env`。

Snap 版 Certbot 自带自动续期任务，会沿用 webroot 验证方式。续期成功后，上面的钩子会检查 Nginx 配置并平滑加载新证书，不中断容器。请保留项目目录、`/etc/letsencrypt` 和 `/var/lib/corec-acme`；如果移动项目，需要重新创建钩子软链接。

## 后续更新

以后启动、更新、查看状态都带上 HTTPS 配置文件，避免恢复成普通 HTTP：

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.https.yml up --build -d
docker compose -f docker-compose.yml -f docker-compose.https.yml logs -f web
```

需要手动检查续期流程时，可以运行（不属于首次部署的必需步骤）：

```bash
sudo /snap/bin/certbot renew --cert-name corec-ip --dry-run --run-deploy-hooks
```

证书和私钥保存在服务器的 `/etc/letsencrypt`，不会放入 Git 仓库。Nginx 以只读方式挂载该目录；数据库和 API 端口仍不对公网开放。

官方说明：[Let's Encrypt 的 Certbot 公网 IP 证书指南](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)。
