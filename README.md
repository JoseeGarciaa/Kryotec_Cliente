# Kryotec Cliente (MVC - TypeScript + Express)

Login multitenant por esquema en PostgreSQL. Usa `search_path` para aislar cada cliente (`tenant_<nombre>`), partiendo de un `tenant_base`.

## Desarrollo

1. Copia `.env.example` a `.env` y ajusta si hace falta.
2. Instala dependencias.
3. Ejecuta en modo desarrollo.

## Despliegue en Railway

- Define variables de entorno: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET`, `PORT`.
- Comando de start: `npm run start` (usando la carpeta `dist`).

