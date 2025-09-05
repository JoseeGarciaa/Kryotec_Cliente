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
};

export const config: AppConfig = {
  db: {
    host: process.env.DB_HOST || '31.97.218.31',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'kryosenseadmin',
    password: process.env.DB_PASSWORD || 'kryosense2025',
    database: process.env.DB_NAME || 'kryosense_test',
  },
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_me',
  defaultTenant: process.env.DEFAULT_TENANT,
};
