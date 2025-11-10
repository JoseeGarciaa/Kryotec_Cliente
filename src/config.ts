import dotenv from 'dotenv';
dotenv.config();

export type AppConfig = {
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  jwtSecret: string;
  defaultTenant?: string; // e.g., "tenant_brandon" for localhost dev
  security: {
    maxFailedAttempts: number;
    lockMinutes: number;
    passwordMinLength: number;
    passwordMaxAgeDays: number;
    defaultSessionMinutes: number;
    minSessionMinutes: number;
    maxSessionMinutes: number;
  };
};

export const config: AppConfig = {
  db: {
    host: process.env.DB_HOST || '31.97.218.31',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'kryosenseadmin',
    password: process.env.DB_PASSWORD || 'kryosense2025',
  // Main branch: use production schema 'kryosense' (DEV branch should keep 'kryosense_test')
  database: process.env.DB_NAME || 'kryosense',
  },
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_me',
  defaultTenant: process.env.DEFAULT_TENANT,
  security: {
    maxFailedAttempts: Math.max(3, Number(process.env.LOGIN_MAX_ATTEMPTS || 5)),
    lockMinutes: Math.max(5, Number(process.env.LOGIN_LOCK_MINUTES || 15)),
    passwordMinLength: 8,
    passwordMaxAgeDays: Math.max(30, Number(process.env.PASSWORD_MAX_AGE_DAYS || 180)),
    defaultSessionMinutes: Math.max(30, Number(process.env.DEFAULT_SESSION_MINUTES || 120)),
    minSessionMinutes: Math.max(15, Number(process.env.MIN_SESSION_MINUTES || 30)),
    maxSessionMinutes: Math.max(60, Number(process.env.MAX_SESSION_MINUTES || 720)),
  },
};
