-- Migration 0002: add tunnel_enabled column to clients
ALTER TABLE clients ADD COLUMN tunnel_enabled INTEGER NOT NULL DEFAULT 0;
