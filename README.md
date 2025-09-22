# Kryotec Cliente

Aplicación web (MVC) construida con **TypeScript + Express + EJS + Tailwind**. Implementa autenticación y operación multi‑tenant mediante separación lógica por esquemas PostgreSQL (`tenant_<nombre>`) aprovechando `search_path` para aislar datos. Incluye flujo de registro, inspección, inventario, notificaciones y panel de auditoría.

## Tabla de Contenido
1. Características
2. Arquitectura
3. Requisitos Previos
4. Instalación (Desarrollo)
5. Variables de Entorno
6. Scripts NPM
7. Flujo de Build / Ejecutar
8. Despliegue en Producción (VPS)
9. Despliegue Automático (CI/CD)
10. Multi‑Tenant (Resumen Técnico)
11. Seguridad y Buenas Prácticas
12. Rollback / Recuperación
13. Estructura de Directorios
14. Licencia / Soporte

## 1. Características
- Multi‑tenant por esquema PostgreSQL (aislamiento lógico)
- Autenticación con JWT + middleware de roles
- Organización modular: controladores, rutas, modelos, servicios
- Vistas EJS + Tailwind CSS + JS modular en `public/js`
- Notificaciones / alertas (modelo `Alerts`)
- Scripts de despliegue (`deploy/`) con systemd + Nginx + Certbot
- Pipeline de auto‑deploy (GitHub Actions)

## 2. Arquitectura
```
Browser -> Nginx (reverse proxy) -> Node/Express (puerto 3000) -> PostgreSQL
											 |-- public assets (Tailwind build)        (Schemas tenant_*)
```
Componentes clave:
- `src/server.ts`: arranque HTTP.
- `src/config.ts`: carga de configuración/env.
- `src/db/pool.ts`: pool de conexiones PostgreSQL.
- Middlewares: autenticación, tenant detection, roles.
- Rutas en `src/routes/` y controladores en `src/controllers/`.

## 3. Requisitos Previos (Dev)
- Node.js 20+
- PostgreSQL 13+ (recomendado)
- npm 9+

## 4. Instalación (Desarrollo)
```bash
cp .env.example .env   # editar valores locales
npm install
npm run dev            # (si existe script nodemon/turbo; de lo contrario usar build+start)
```
Si no existe script `dev`, usar:
```bash
npm run build
npm start
```

## 5. Variables de Entorno
| Variable | Descripción | Obligatoria | Ejemplo |
|----------|-------------|------------|---------|
| DB_HOST | Host PostgreSQL | Sí | 127.0.0.1 |
| DB_PORT | Puerto DB | Sí | 5432 |
| DB_USER | Usuario DB | Sí | kryosenseadmin |
| DB_PASSWORD | Password DB | Sí | ******** |
| DB_NAME | Base principal (main) | Sí | kryosense |
| JWT_SECRET | Clave firma JWT | Sí | cadena_segura_larga |
| DEFAULT_TENANT | Tenant por defecto | Opcional | tenant_base |
| PORT | Puerto HTTP | Sí | 3000 |
| NODE_ENV | Ambiente | Sí | production |

## 6. Scripts NPM
| Script | Acción |
|--------|--------|
| `build` | Compila TypeScript a `dist/` |
| `start` | Inicia en modo producción usando `dist/server.js` |
| (opcional) `dev` | Modo desarrollo (si se agrega nodemon) |

## 7. Flujo de Build / Ejecutar
1. Editar .env
2. `npm install`
3. `npm run build`
4. `npm start` (sirve `dist/`)

## 8. Despliegue Producción (Resumen VPS)
Pasos completos en `deploy/README_DEPLOY.md`. Resumen:
```bash
# Paquetes base
apt update && apt -y upgrade
apt install -y git curl build-essential nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Clonar
mkdir -p /var/www/kryotec && cd /var/www/kryotec
git clone <ssh_repo_url> .
cp .env.example .env && nano .env

# Build
npm install
npm run build

# Systemd
cp deploy/kryotec.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now kryotec

# Nginx + SSL
cp deploy/nginx.conf.example /etc/nginx/sites-available/kryotec.conf
ln -s /etc/nginx/sites-available/kryotec.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
apt install -y certbot python3-certbot-nginx
certbot --nginx -d kryotecsense.com -d www.kryotecsense.com
```
Deploy incremental:
```bash
bash deploy/deploy.sh
```

## 9. Despliegue Automático (CI/CD)
Workflow `.github/workflows/deploy.yml` ejecuta en push a `main` y corre el script remoto. Requiere secrets (`VPS_HOST`, `VPS_USER`, credencial SSH o password). Recomendado migrar a clave SSH en lugar de password.

## 10. Multi‑Tenant (Resumen Técnico)
- Cada cliente se mapea a un esquema: `tenant_nombre`.
- Middleware selecciona `search_path` antes de ejecutar queries.
- Aislamiento lógico: las tablas se replican por esquema; el código se mantiene único.
- `DEFAULT_TENANT` se usa si no se identifica subdominio / contexto.

## 11. Seguridad / Buenas Prácticas
- Deshabilitar acceso root SSH (`PermitRootLogin no`).
- Autenticación sólo por clave pública.
- `NODE_ENV=production` obligatoriamente en producción.
- JWT secreto robusto (>=32 chars aleatorios). Rotar periódicamente.
- Limitar puerto 5432 (firewall) o usar túnel SSH.
- Certificados renovados automáticamente (`certbot renew --dry-run`).
- Backups de DB (`pg_dump`) programados.
- Revisar logs: `journalctl -u kryotec -f`.

## 12. Rollback / Recuperación
```bash
# Ver commits
git log --oneline -n 10

# Volver a commit específico
git checkout <hash>
npm install && npm run build
systemctl restart kryotec

# Usar tags para versiones estables
git tag -a v1.0.0 -m "Release estable"
git push origin v1.0.0
```
Para volver a `main`:
```bash
git checkout main
git pull origin main
bash deploy/deploy.sh
```

## 13. Estructura de Directorios (parcial)
```
src/
	controllers/   # Lógica de cada módulo
	routes/        # Definición de endpoints
	middleware/    # Auth, roles, tenant
	models/        # Modelos / acceso datos
	db/pool.ts     # Pool PostgreSQL
	config.ts      # Configuración central
public/
	js/            # JS frontend modular
	css/           # CSS compilado / base
deploy/          # Archivos de infraestructura
dist/            # Salida compilada TS
```

## 14. Licencia / Soporte
Uso interno / entrega a cliente. Añadir licencia formal si se distribuye externamente. Para soporte técnico: documentar contacto interno (correo / canal).

---
**Checklist Rápido Producción**
- [ ] `.env` completo
- [ ] Build exitoso (`dist/`)
- [ ] Servicio systemd activo
- [ ] Nginx + SSL OK
- [ ] Logs limpios (sin errores críticos)
- [ ] Backup inicial DB realizado

---
> Documentación adicional detallada (procedimientos ampliados de despliegue, hardening y rollback) se encuentra en `deploy/README_DEPLOY.md` y guía extendida interna.


