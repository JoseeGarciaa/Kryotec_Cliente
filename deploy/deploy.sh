#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/var/www/kryotec
BRANCH=main

if [ ! -d "$APP_DIR/.git" ]; then
  echo "[deploy] Clonando repo inicial";
  sudo mkdir -p "$APP_DIR";
  sudo chown $(whoami):$(whoami) "$APP_DIR";
  git clone https://github.com/JoseeGarciaa/Kryotec_Cliente.git "$APP_DIR";
fi

cd "$APP_DIR"

echo "[deploy] Fetch/Pull";
git fetch origin;
git checkout $BRANCH;
git pull origin $BRANCH;

echo "[deploy] Instalando dependencias";
npm install --production=false;

echo "[deploy] Build";
npm run build;

echo "[deploy] Reiniciando servicio";
sudo systemctl restart kryotec || sudo systemctl start kryotec;

echo "[deploy] Listo";
