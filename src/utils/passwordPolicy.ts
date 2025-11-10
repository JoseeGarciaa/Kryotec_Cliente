import { config } from '../config';

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

export const PASSWORD_POLICY_MESSAGE = 'La contraseña debe tener al menos 8 caracteres, incluir mayúsculas, minúsculas, números y un carácter especial.';

export function validatePasswordStrength(password: string): boolean {
  if (typeof password !== 'string') return false;
  if (password.length < config.security.passwordMinLength) return false;
  return PASSWORD_REGEX.test(password);
}

export function normalizeSessionTtl(input: unknown): number {
  const raw = Number(input);
  if (!Number.isFinite(raw)) return config.security.defaultSessionMinutes;
  return Math.max(
    config.security.minSessionMinutes,
    Math.min(config.security.maxSessionMinutes, Math.round(raw))
  );
}
