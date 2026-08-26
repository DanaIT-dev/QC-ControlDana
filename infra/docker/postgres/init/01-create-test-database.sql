SELECT 'CREATE DATABASE sgr_registry_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'sgr_registry_test')\gexec
