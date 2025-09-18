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
import expressStatic from 'express';
// @ts-ignore types optional
import expressLayouts from 'express-ejs-layouts';
import { restrictByRole } from './middleware/roles';
import { resolveTenant } from './middleware/tenant';
import { withTenant } from './db/pool';
import { UsersModel } from './models/User';
import { AlertsModel } from './models/Alerts';
import fs from 'fs';

dotenv.config();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'src', 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// Helmet con HSTS deshabilitado en desarrollo para evitar forzar HTTPS (causa ERR_SSL_PROTOCOL_ERROR en http://localhost)
app.use(helmet({
	hsts: process.env.NODE_ENV === 'production' ? undefined : false
} as any));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
const staticDir = path.join(process.cwd(), 'public');
app.use('/static', expressStatic.static(staticDir, {
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

// Serve static pre-sized icons if present; fallback to favicon
app.get(['/icons/icon-192.png','/icons/icon-512.png'], (req, res) => {
	const filename = req.path.endsWith('512.png') ? 'icon-512.png' : 'icon-192.png';
	const vect = path.join(staticDir, 'images', 'vect.png');
	const candidate = path.join(staticDir, 'images', filename);
	const fallback = path.join(staticDir, 'images', 'favicon.png');
	let fileToSend = candidate;
	try {
		const st = fs.statSync(candidate);
		if (!st.isFile() || st.size < 1024) {
			fileToSend = fs.existsSync(vect) ? vect : fallback;
		}
	} catch {
		fileToSend = fs.existsSync(vect) ? vect : fallback;
	}
	res.type('image/png');
	res.setHeader('Cache-Control', process.env.NODE_ENV === 'production' ? 'public, max-age=604800, immutable' : 'no-cache');
	res.sendFile(fileToSend);
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
