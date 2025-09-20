# Despliegue en VPS (Hostinger)

## 1. Preparar servidor
```bash
apt update && apt -y upgrade
apt install -y git curl build-essential nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v && npm -v
```

## 2. Usuario y carpeta
```bash
mkdir -p /var/www/kryotec
cd /var/www/kryotec
```

## 3. Clonar + .env
```bash
git clone https://github.com/JoseeGarciaa/Kryotec_Cliente.git .
cp .env.example .env  # editar valores reales
```

## 4. Build
```bash
npm install
npm run build
```

## 5. Systemd
Copiar `deploy/kryotec.service` a `/etc/systemd/system/kryotec.service`:
```bash
cp deploy/kryotec.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable kryotec
systemctl start kryotec
systemctl status kryotec
```

## 6. Nginx
```bash
cp deploy/nginx.conf.example /etc/nginx/sites-available/kryotec.conf
ln -s /etc/nginx/sites-available/kryotec.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 7. SSL
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d kryotecsense.com -d www.kryotecsense.com
```

## 8. Deploy script
```bash
bash deploy/deploy.sh
```

## 9. Logs
```bash
journalctl -u kryotec -f
```

## 10. Actualización
Cambia código, luego:
```bash
bash deploy/deploy.sh
```
