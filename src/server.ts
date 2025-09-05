import express, { Request, Response } from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import dotenv from 'dotenv';
import authRoutes from './routes/authRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import inventarioRoutes from './routes/inventarioRoutes';
import registroRoutes from './routes/registroRoutes';
import jwt from 'jsonwebtoken';
import { config } from './config';
import expressStatic from 'express';
// @ts-ignore types optional
import expressLayouts from 'express-ejs-layouts';

dotenv.config();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'src', 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

app.use(helmet());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
const staticDir = path.join(process.cwd(), 'public');
app.use('/static', expressStatic.static(staticDir, {
	maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
	etag: true,
}));

// theme from cookie
app.use((req, res, next) => {
	res.locals.theme = req.cookies?.theme || 'dark';
	res.locals.currentPath = req.path;
	// expose user (decoded) if present
	const token = req.cookies?.token;
	if (token) {
		try {
			res.locals.user = jwt.verify(token, config.jwtSecret);
		} catch {}
	}
	next();
});

app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/inventario', inventarioRoutes);
app.use('/registro', registroRoutes);
app.get('/', (_req: Request, res: Response) => res.redirect('/auth/login'));
app.get('/health', (_req: Request, res: Response) => res.json({ ok: true, env: process.env.NODE_ENV, port: process.env.PORT }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

// Theme toggle
app.post('/ui/theme-toggle', (req, res) => {
	const current = req.cookies?.theme || 'dark';
	const next = current === 'dark' ? 'light' : 'dark';
	res.cookie('theme', next, { httpOnly: false, sameSite: 'lax' });
	const back = (req.headers.referer as string) || '/inventario';
	res.redirect(back);
});
