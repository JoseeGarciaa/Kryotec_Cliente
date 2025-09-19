import express, { Request, Response } from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import dotenv from 'dotenv';
import authRoutes from './routes/authRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import accountRoutes from './routes/accountRoutes';
import notificationsRoutes from './routes/notificationsRoutes';
import inventarioRoutes from './routes/inventarioRoutes';
import registroRoutes from './routes/registroRoutes';
import ordenesRoutes from './routes/ordenesRoutes';
import operacionRoutes from './routes/operacionRoutes';
import administracionRoutes from './routes/administracionRoutes';
import auditoriaRoutes from './routes/auditoriaRoutes';
import jwt from 'jsonwebtoken';
import { config } from './config';
// @ts-ignore types optional
import expressLayouts from 'express-ejs-layouts';
import { restrictByRole } from './middleware/roles';
import { resolveTenant } from './middleware/tenant';
import { withTenant } from './db/pool';
import { UsersModel } from './models/User';
import { AlertsModel } from './models/Alerts';
import fs from 'fs';
import zlib from 'zlib';

dotenv.config();

const app = express();

// Resolve views path robustly (src in repo; fallback to dist in production builds)
const viewsSrc = path.join(process.cwd(), 'src', 'views');
const viewsDist = path.join(process.cwd(), 'dist', 'views');
const viewsPath = fs.existsSync(viewsSrc) ? viewsSrc : (fs.existsSync(viewsDist) ? viewsDist : viewsSrc);

app.set('view engine', 'ejs');
app.set('views', viewsPath);
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// Helmet con HSTS deshabilitado en desarrollo para evitar forzar HTTPS (causa ERR_SSL_PROTOCOL_ERROR en http://localhost)
app.use(helmet({
	// Keep simple defaults; let platform terminate TLS and handle HSTS
	hsts: false,
	contentSecurityPolicy: false,
} as any));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
const staticDir = path.join(process.cwd(), 'public');
app.use('/static', express.static(staticDir, {
	maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
	etag: true,
}));

// PWA assets at root paths
app.get('/manifest.webmanifest', (_req, res) => {
	res.type('application/manifest+json');
	res.sendFile(path.join(staticDir, 'manifest.webmanifest'));
});
app.get('/sw.js', (_req, res) => {
	res.type('application/javascript');
	res.setHeader('Cache-Control', 'no-cache');
	res.sendFile(path.join(staticDir, 'sw.js'));
});

// Favicon at root path for browsers and platform error pages
app.get('/favicon.ico', (_req, res) => {
	res.type('image/png');
	res.setHeader('Cache-Control', process.env.NODE_ENV === 'production' ? 'public, max-age=604800, immutable' : 'no-cache');
	res.sendFile(path.join(staticDir, 'images', 'favicon.png'));
});

// --- Dynamic PNG icon generation (ensures exact 192x192 & 512x512 to satisfy PWA heuristics) ---
// Build and cache solid-color PNGs without external deps.
function crc32(buf: Buffer): number {
	let c = ~0; for (let i = 0; i < buf.length; i++) { c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF]; } return ~c >>> 0;
}
const CRC_TABLE = (() => { const t: number[] = []; for (let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c = (c & 1)? (0xEDB88320 ^ (c>>>1)):(c>>>1); t[i]=c>>>0; } return t; })();
function buildPng(size: number, color: {r:number;g:number;b:number;a:number}): Buffer {
	const { r,g,b,a } = color; // a in 0-255
	const bytesPerPixel = 4;
	const row = Buffer.alloc(1 + size * bytesPerPixel); // filter byte + pixels
	for (let x=0;x<size;x++) { const o = 1 + x*4; row[o]=r; row[o+1]=g; row[o+2]=b; row[o+3]=a; }
	const raw = Buffer.alloc((1 + size * bytesPerPixel) * size);
	for (let y=0;y<size;y++) row.copy(raw, y * row.length);
	const compressed = zlib.deflateSync(raw, { level: 9 });
	function chunk(type: string, data: Buffer){
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length,0);
		const typeBuf = Buffer.from(type,'ascii');
		const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf,data])),0);
		return Buffer.concat([len,typeBuf,data,crcBuf]);
	}
	const signature = Buffer.from([137,80,78,71,13,10,26,10]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size,0); // width
	ihdr.writeUInt32BE(size,4); // height
	ihdr[8]=8; // bit depth
	ihdr[9]=6; // color type RGBA
	ihdr[10]=0; ihdr[11]=0; ihdr[12]=0; // compression/filter/interlace
	const ihdrChunk = chunk('IHDR', ihdr);
	const idatChunk = chunk('IDAT', compressed);
	const iendChunk = chunk('IEND', Buffer.alloc(0));
	return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}
const ICON_CACHE: Record<string, Buffer> = {};
function getIcon(size: number): Buffer {
	const key = String(size);
	if (!ICON_CACHE[key]) {
		// Brand color base (#6d5efc) with full opacity
		ICON_CACHE[key] = buildPng(size, { r: 0x6d, g: 0x5e, b: 0xfc, a: 255 });
	}
	return ICON_CACHE[key];
}
app.get(['/icons/icon-192.png','/icons/icon-512.png'], (req, res) => {
	const size = req.path.endsWith('512.png') ? 512 : 192;
	const buf = getIcon(size);
	res.setHeader('Content-Type','image/png');
	res.setHeader('Content-Length', String(buf.length));
	res.setHeader('Cache-Control', process.env.NODE_ENV === 'production' ? 'public, max-age=604800, immutable' : 'no-cache');
	res.end(buf);
});

// theme from cookie
app.use(async (req, res, next) => {
	res.locals.theme = req.cookies?.theme || 'dark';
	res.locals.currentPath = req.path;
	// asset version for cache-busting across environments
	(res.locals as any).assetVersion = process.env.ASSET_VERSION || process.env.RAILWAY_GIT_COMMIT_SHA || String(Date.now());
	// expose user (decoded) if present
	const token = req.cookies?.token;
	if (token) {
		try {
			res.locals.user = jwt.verify(token, config.jwtSecret);
		} catch {}
	}
	// Si falta nombre/correo en el token (tokens antiguos), completarlo desde BD
	try {
		const u: any = (res.locals as any).user;
		if (u && (!u.nombre || !u.correo)) {
			const t = resolveTenant(req) || u.tenant;
			if (t && u.sub) {
				const userRow = await withTenant(t, (client) => UsersModel.findById(client, Number(u.sub)));
				if (userRow) {
					(res.locals as any).user = { ...u, nombre: userRow.nombre, correo: userRow.correo };
				}
			}
		}
	} catch {}
	// res.locals.user.rol se usa para condicionar navegación (Administración solo admins)
	try {
		// Inicializar tabla e instalar trigger de trazabilidad por tenant (idempotente/rápido)
		const t = (res.locals as any).user?.tenant || resolveTenant(req);
		if (t) {
			await withTenant(t, async (client) => {
				await AlertsModel.ensureTable(client);
				await AlertsModel.ensureStateChangeTrigger(client);
			});
		}
	} catch {}
	next();
});

// Middleware de restricción por rol (debe ir antes de montar rutas protegidas)
app.use(restrictByRole);

app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/cuenta', accountRoutes);
app.use('/notificaciones', notificationsRoutes);
app.use('/inventario', inventarioRoutes);
app.use('/ordenes', ordenesRoutes);
app.use('/registro', registroRoutes);
app.use('/operacion', operacionRoutes);
app.use('/auditoria', auditoriaRoutes);
app.use('/administracion', administracionRoutes);
app.get('/', (_req: Request, res: Response) => res.redirect('/auth/login'));
app.get('/health', (_req: Request, res: Response) => res.json({ ok: true, env: process.env.NODE_ENV, port: process.env.PORT }));

// Minimal landing page used as PWA start_url (avoids heavy DB/middleware work before SW installs)
app.get('/pwa-start', (_req: Request, res: Response) => {
	res.type('html').send(`<!DOCTYPE html>
	<html lang="es"><head>
		<meta charset="utf-8" />
		<title>KryoSense</title>
		<link rel="manifest" href="/manifest.webmanifest" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<link rel="icon" type="image/png" href="/static/images/favicon.png" />
		<link rel="stylesheet" href="/static/css/app.css?v=${(Date.now())}" />
	</head>
	<body class="min-h-screen flex items-center justify-center">
		<div class="text-center text-sm opacity-70">
			<p>Inicializando aplicación…</p>
			<p class="mt-2">Si ves esta pantalla más de 3s, recarga o visita <a class="link" href="/auth/login">/auth/login</a>.</p>
		</div>
		<script src="/static/js/pwa.js" defer></script>
		<script>setTimeout(()=>{ if(!sessionStorage.getItem('kryo_auto_nav')){ sessionStorage.setItem('kryo_auto_nav','1'); location.replace('/auth/login'); } }, 2500);</script>
	</body></html>`);
});

// Robots
app.get('/robots.txt', (_req, res) => {
	res.type('text/plain');
	res.send('User-agent: *\nDisallow:');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

// Theme toggle
app.post('/ui/theme-toggle', (req, res) => {
	const current = req.cookies?.theme || 'dark';
	const next = current === 'dark' ? 'light' : 'dark';
	res.cookie('theme', next, { httpOnly: false, sameSite: 'lax' });
	const postedBack = (req.body && (req.body as any).back) as string | undefined;
	const back = (postedBack && typeof postedBack === 'string') ? postedBack : ((req.headers.referer as string) || '/inventario');
	res.redirect(back);
});

// Explicitly set theme to avoid client/server mismatch when saving user preference
app.post('/ui/theme-set', (req, res) => {
	const desired = (req.body as any)?.theme === 'light' ? 'light' : ((req.body as any)?.theme === 'dark' ? 'dark' : null);
	if (!desired) return res.status(400).json({ ok: false, error: 'invalid theme' });
	res.cookie('theme', desired, { httpOnly: false, sameSite: 'lax' });
	return res.json({ ok: true, theme: desired });
});
