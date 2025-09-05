import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/auth/login');
  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;
    (req as any).user = payload;
    next();
  } catch (e) {
    res.clearCookie('token');
    return res.redirect('/auth/login');
  }
}
