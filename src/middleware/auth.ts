import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { getRequestSedeId } from '../utils/sede';
import { runWithSedeContext } from '../utils/sedeContext';
import { runWithUserContext } from '../utils/userContext';
import { withTenant } from '../db/pool';
import { UsersModel } from '../models/User';
import { ensureSecurityArtifacts } from '../services/securityBootstrap';

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/auth/login');
  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;
    const tenant = payload?.tenant as string | undefined;
    const rawUserId = (payload && (payload.id ?? payload.user_id ?? payload.user?.id ?? payload.sub)) ?? null;
    const parsedUserId = typeof rawUserId === 'number'
      ? (Number.isFinite(rawUserId) ? rawUserId : null)
      : rawUserId !== null && rawUserId !== undefined && rawUserId !== '' && !Number.isNaN(Number(rawUserId))
        ? Number(rawUserId)
        : null;

    if (!tenant || !parsedUserId) {
      res.clearCookie('token');
      return res.redirect('/auth/login');
    }

    await ensureSecurityArtifacts(tenant);
    const snapshot = await withTenant(tenant, (client) => UsersModel.getSecuritySnapshot(client, parsedUserId));
    if (!snapshot) {
      res.clearCookie('token');
      return res.redirect('/auth/login');
    }

    if (!snapshot.activo) {
      res.clearCookie('token');
      return res.redirect('/auth/login');
    }

    const tokenSessionVersion = Number(payload?.sessionVersion || 0);
    if (snapshot.session_version !== tokenSessionVersion) {
      res.clearCookie('token');
      return res.redirect('/auth/login');
    }

    const now = Date.now();
    if (snapshot.bloqueado_hasta && new Date(snapshot.bloqueado_hasta).getTime() > now) {
      res.clearCookie('token');
      return res.redirect('/auth/login');
    }

    const referenceDate = snapshot.contrasena_cambiada_en || snapshot.fecha_creacion;
    const maxAgeMs = config.security.passwordMaxAgeDays * 24 * 60 * 60 * 1000;
    let mustChangePassword = Boolean(snapshot.debe_cambiar_contrasena);
    if (referenceDate) {
      const expiresAt = new Date(referenceDate).getTime() + maxAgeMs;
      if (expiresAt <= now) {
        if (!snapshot.debe_cambiar_contrasena) {
          await withTenant(tenant, (client) => UsersModel.forcePasswordReset(client, parsedUserId));
        }
        mustChangePassword = true;
      } else {
        const daysRemaining = Math.ceil((expiresAt - now) / 86400000);
        if (daysRemaining > 0 && daysRemaining <= 15) {
          (res.locals as any).securityWarning = `Tu contraseña vence en ${daysRemaining} día(s). Actualízala desde la sección "Mi cuenta".`;
        }
      }
    }

    (req as any).user = { ...payload, mustChangePassword };
    (res.locals as any).user = { ...(res.locals as any).user, ...payload, mustChangePassword };

  const mustChange = mustChangePassword;
  const rawFullPath = `${req.baseUrl || ''}${req.path}` || req.path;
  const fullPath = rawFullPath.length > 1 ? rawFullPath.replace(/\/+$/, '') || '/' : rawFullPath;
    const allowedWhenPending = ['/cuenta', '/cuenta/change-password', '/cuenta/update-profile', '/auth/logout'];
    if (mustChange && !allowedWhenPending.some((p) => fullPath === p || fullPath.startsWith(p + '/'))) {
      if (req.method.toUpperCase() === 'GET') {
        return res.redirect('/cuenta?mustChange=1');
      }
      return res.status(403).json({ ok: false, error: 'Debes actualizar tu contraseña.' });
    }

    const sedeId = getRequestSedeId(req);
    return runWithUserContext(parsedUserId, () => runWithSedeContext(sedeId, () => next()));
  } catch (e) {
    res.clearCookie('token');
    return res.redirect('/auth/login');
  }
}
