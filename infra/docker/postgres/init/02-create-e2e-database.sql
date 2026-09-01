SELECT 'CREATE DATABASE sgr_registry_e2e'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'sgr_registry_e2e')\gexec
