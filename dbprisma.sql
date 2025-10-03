-- --------------------------------------------------------
-- Servidor:                     127.0.0.1
-- Versão do servidor:           PostgreSQL 16.3, compiled by Visual C++ build 1939, 64-bit
-- OS do Servidor:               
-- HeidiSQL Versão:              12.1.0.6537
-- --------------------------------------------------------

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES  */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

-- Copiando estrutura para tabela public.app_state_keys
CREATE TABLE IF NOT EXISTS "app_state_keys" (
	"id" TEXT NOT NULL,
	"instanceId" TEXT NOT NULL,
	"keyId" TEXT NOT NULL,
	"keyData" BYTEA NOT NULL,
	"createdAt" TIMESTAMP NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	PRIMARY KEY ("id"),
	UNIQUE INDEX "app_state_keys_instanceId_keyId_key" ("instanceId", "keyId"),
	CONSTRAINT "app_state_keys_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("instanceId") ON UPDATE CASCADE ON DELETE CASCADE
);

-- Copiando dados para a tabela public.app_state_keys: 0 rows
/*!40000 ALTER TABLE "app_state_keys" DISABLE KEYS */;
/*!40000 ALTER TABLE "app_state_keys" ENABLE KEYS */;

-- Copiando estrutura para tabela public.app_state_versions
CREATE TABLE IF NOT EXISTS "app_state_versions" (
	"id" TEXT NOT NULL,
	"instanceId" TEXT NOT NULL,
	"name" TEXT NOT NULL,
	"version" INTEGER NOT NULL,
	"hash" BYTEA NULL DEFAULT NULL,
	"createdAt" TIMESTAMP NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	"updatedAt" TIMESTAMP NOT NULL,
	PRIMARY KEY ("id"),
	UNIQUE INDEX "app_state_versions_instanceId_name_key" ("instanceId", "name")
);

-- Copiando dados para a tabela public.app_state_versions: 0 rows
/*!40000 ALTER TABLE "app_state_versions" DISABLE KEYS */;
/*!40000 ALTER TABLE "app_state_versions" ENABLE KEYS */;

-- Copiando estrutura para tabela public.connection_logs
CREATE TABLE IF NOT EXISTS "connection_logs" (
	"id" TEXT NOT NULL,
	"instanceId" TEXT NOT NULL,
	"event" TEXT NOT NULL,
	"status" TEXT NULL DEFAULT NULL,
	"message" TEXT NULL DEFAULT NULL,
	"metadata" JSONB NULL DEFAULT NULL,
	"timestamp" TIMESTAMP NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	PRIMARY KEY ("id"),
	CONSTRAINT "connection_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("instanceId") ON UPDATE CASCADE ON DELETE CASCADE
);

-- Copiando dados para a tabela public.connection_logs: 0 rows
/*!40000 ALTER TABLE "connection_logs" DISABLE KEYS */;
/*!40000 ALTER TABLE "connection_logs" ENABLE KEYS */;

-- Copiando estrutura para tabela public.credentials
CREATE TABLE IF NOT EXISTS "credentials" (
	"instanceId" TEXT NOT NULL,
	"registrationId" INTEGER NOT NULL,
	"noiseKey" TEXT NOT NULL,
	"identityKey" TEXT NOT NULL,
	"advSecretKey" TEXT NULL DEFAULT NULL,
	"signedPreKeyId" INTEGER NULL DEFAULT NULL,
	"signedPreKeyPub" TEXT NULL DEFAULT NULL,
	"signedPreKeyPriv" TEXT NULL DEFAULT NULL,
	"signedPreKeySig" TEXT NULL DEFAULT NULL,
	"updatedAt" TIMESTAMP NOT NULL,
	PRIMARY KEY ("instanceId"),
	CONSTRAINT "credentials_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("instanceId") ON UPDATE CASCADE ON DELETE CASCADE
);

-- Copiando dados para a tabela public.credentials: 1 rows
/*!40000 ALTER TABLE "credentials" DISABLE KEYS */;
INSERT INTO "credentials" ("instanceId", "registrationId", "noiseKey", "identityKey", "advSecretKey", "signedPreKeyId", "signedPreKeyPub", "signedPreKeyPriv", "signedPreKeySig", "updatedAt") VALUES
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 148, '{"private":"eDVH8iMTqQxxgnqDR+MgDUnvI8XAaecTnqhfFJc53Vg=","public":"7TMzu9/eabtOkRDNQhz3++vPUBwdiauM/RcC4DOANGI="}', '{"private":"uJPhxFHWipK1XnmLObxU2z6sVDr4FmXtz2Xu9b0SoWk=","public":"WF1R/KKWLltkyM/w5Y1IN00cEaWf2/DqUBxj0L9honc="}', 'Lq77ZtC7j/hmesx79DD+hlxONBRyBUHaM7XI3dzgmYw=', 1, 'fLIuVkrgJzks4XQTyL0XM9dFqCFyyf5VG90O+pkbZTo=', '+OVn5/g+lWbvJ2knZBYj5dCY3UsekdXgzcqL+uh96U0=', 'KBgaZg1MFUDDw+eOP4nsKeBiGu1WJXR8vTwJZa98VrYK65XZrkk5wFG/EoORIo9RI7epZ4CgsG6rNoog3KQ1Bw==', '2025-10-02 04:59:42.05');
/*!40000 ALTER TABLE "credentials" ENABLE KEYS */;

-- Copiando estrutura para tabela public.identities
CREATE TABLE IF NOT EXISTS "identities" (
	"id" INTEGER NOT NULL DEFAULT 'nextval(''identities_id_seq''::regclass)',
	"instanceId" TEXT NOT NULL,
	"jid" TEXT NOT NULL,
	"identityKey" TEXT NOT NULL,
	"trustLevel" INTEGER NOT NULL DEFAULT '0',
	"createdAt" TIMESTAMP NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	"updatedAt" TIMESTAMP NOT NULL,
	PRIMARY KEY ("id"),
	UNIQUE INDEX "identities_instanceId_jid_key" ("instanceId", "jid"),
	CONSTRAINT "identities_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("instanceId") ON UPDATE CASCADE ON DELETE CASCADE
);

-- Copiando dados para a tabela public.identities: 0 rows
/*!40000 ALTER TABLE "identities" DISABLE KEYS */;
/*!40000 ALTER TABLE "identities" ENABLE KEYS */;

-- Copiando estrutura para tabela public.instances
CREATE TABLE IF NOT EXISTS "instances" (
	"id" TEXT NOT NULL,
	"instanceId" TEXT NOT NULL,
	"nameDevice" TEXT NULL DEFAULT NULL,
	"numberDevice" TEXT NULL DEFAULT NULL,
	"webhookUrl" TEXT NULL DEFAULT NULL,
	"events" UNKNOWN NULL DEFAULT 'ARRAY[]::text[]',
	"status" TEXT NOT NULL DEFAULT 'disconnected',
	"platform" TEXT NULL DEFAULT NULL,
	"createdAt" TIMESTAMP NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	"updatedAt" TIMESTAMP NOT NULL,
	"lastAccess" TIMESTAMP NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	PRIMARY KEY ("id"),
	UNIQUE INDEX "instances_instanceId_key" ("instanceId")
);

-- Copiando dados para a tabela public.instances: 1 rows
/*!40000 ALTER TABLE "instances" DISABLE KEYS */;
INSERT INTO "instances" ("id", "instanceId", "nameDevice", "numberDevice", "webhookUrl", "events", "status", "platform", "createdAt", "updatedAt", "lastAccess") VALUES
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', '910cfaae-ee6c-4f38-9c73-dc8525167a12', '11', NULL, NULL, '{messages,connection}', 'disconnected', NULL, '2025-10-02 04:58:52.49', '2025-10-02 04:58:52.49', '2025-10-02 04:58:52.49');
/*!40000 ALTER TABLE "instances" ENABLE KEYS */;

-- Copiando estrutura para tabela public.message_logs
CREATE TABLE IF NOT EXISTS "message_logs" (
	"id" TEXT NOT NULL,
	"instanceId" TEXT NOT NULL,
	"messageId" TEXT NULL DEFAULT NULL,
	"fromJid" TEXT NULL DEFAULT NULL,
	"toJid" TEXT NULL DEFAULT NULL,
	"messageType" TEXT NULL DEFAULT NULL,
	"content" TEXT NULL DEFAULT NULL,
	"metadata" JSONB NULL DEFAULT NULL,
	"timestamp" TIMESTAMP NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	PRIMARY KEY ("id"),
	CONSTRAINT "message_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("instanceId") ON UPDATE CASCADE ON DELETE CASCADE
);

-- Copiando dados para a tabela public.message_logs: 0 rows
/*!40000 ALTER TABLE "message_logs" DISABLE KEYS */;
/*!40000 ALTER TABLE "message_logs" ENABLE KEYS */;

-- Copiando estrutura para tabela public.pre_keys
CREATE TABLE IF NOT EXISTS "pre_keys" (
	"instanceId" TEXT NOT NULL,
	"used" BOOLEAN NOT NULL DEFAULT 'false',
	"usedAt" TIMESTAMP NULL DEFAULT NULL,
	"createdAt" TIMESTAMP NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	"private" TEXT NOT NULL,
	"public" TEXT NOT NULL,
	"id" INTEGER NOT NULL,
	PRIMARY KEY ("id"),
	UNIQUE INDEX "pre_keys_instanceId_id_key" ("instanceId", "id"),
	CONSTRAINT "pre_keys_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("instanceId") ON UPDATE CASCADE ON DELETE CASCADE
);

-- Copiando dados para a tabela public.pre_keys: 60 rows
/*!40000 ALTER TABLE "pre_keys" DISABLE KEYS */;
INSERT INTO "pre_keys" ("instanceId", "used", "usedAt", "createdAt", "private", "public", "id") VALUES
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', 'SPMOjdGuCaTCUjEU2I6bBu8jWjZzLkzl/kbjlEwFXlA=', 'nEjoUqoLah0oHVBrB4fbwliwDBDBtVjYpn0DFvpKkgI=', 7),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', 'iFyN/4196AE0QVXhsUhuEKiYy/FT55dyVhv+XsPfUUA=', 'tFdQpxkJcqQNQjiX6NZKi7/f+PK8+uzz4HTmErLmUT0=', 2),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', '+JMo9B0YhM5h7IKJLL49QfRNYvVvHfgvaDLaACopb0o=', 'n6djKws40e+qqYrUSHsgh4n/0tZFwvr8Ur64bEbirVs=', 1),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', 'AJu1QeGzquCqfCL4jHwKfL04s6HZ897XMSW/2jkAxng=', 'x5QkZLY5wPlvTTgKXvHNrz7ZnuRFsvRuZDQ5Q/Zf73c=', 4),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', 'MMztYLT+Y0mpq6HD/YRJgO5fIErMCE+M9w1bqZVTx1g=', 'llPvO8O+6SL+Zwgjwlol+8Zakp+MMJbThXuwRE0mJig=', 5),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', 'MNNOSlrDxg5f3o3LWuZMMzSwVdZyEQRHcXsZ2Xm550c=', 'BfUyC6UALN5qI+frAkJRm5qTpIMcPfFpsBQHWMuDUmU=', 12),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', 'IP96dUjAYMgwHumPMNvNbonYiCeOXoLkX34yr3Qx/20=', 'jvEH/YCnXPgEhft85CuZWvFubzI6/w6ATQFwisMKzgs=', 10),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', 'cNikMnP8tI7fGks+hMYrynYdY8PJ58zy8gdwwV3vGWE=', 'tVcKL6RbneLWqLuSj5gUUTLn+WvCobDcEk5Q1qQOcik=', 13),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', 'wPUXSVDKJPBA3s3EJccp165zb1cIvN3+A1suutwTCE8=', 'MFLtaPYMUkCrN8hneB80uF2M9HLzPExhDPDD4lp7lUI=', 3),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', 'oHVETwwa57UhWjJH64iykmqQClGay9irwngR9nhtnnU=', 'GejIxAIy1IPl4rtJVDs9QYS2FEyjWRUaLq4mNlQi3GE=', 9),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', '+EmV5McTG2VsPKP3OdQjSOS55mY98e+uuzByqa7KEEc=', 'dMl0xrK4HH/Ulvl0Y7AY6rXgqdIbSWCmwEjG46O78BI=', 8),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'iE9C/MKrnxsuk2OaygYNXtISH5bz5uziwchD68F/Jlw=', 'V6oNIo0BW2i+Oqhw0Oej01n2C4pwtJTvB5694RpM/Uc=', 14),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.429', 'eIRxad6mvc/ot/I51j1Dr5C+58LzFoNq/D7zEpJ+Pno=', 'AsuvB5UXlqurGoxoSLro9RIRF+KVY0ukSvfkQPk2NE8=', 6),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'SPpzhbZAjSYDL1Dr45arcvExPP85B2TcjHxGHIoKTX0=', 'OOusVNLBK0PfNdOACZGQIO/EpjtCZAHO92YvhNYxvm8=', 19),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'YDxoU/KW8XkazDFm53D47qTSaJQ2MkeNxjNpnor5wHc=', 'XO+7eXn2Uw+H9bHD611INeKJAgxQ5047b4tM4KfScGo=', 25),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'gLJYewM6YBXdM0vuVHKwVEa0KAizZnfn4rD5pHCjaEc=', 'ecUO9fDHFHMox8fOMyq+aIYoxsE7Y37KT+RLg2UhO1k=', 18),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'yOr9ZqfkWXJ2nPCWttpk7M2ydK60LjfJGfgtmBg4Q1g=', 'nWGS5rSYwiZFRQs0Kzk27UBGKdIZDkZMHaelmQ5nNhI=', 22),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', 'CBrcxYqw+T5W3R0yb8Ucz5PIlBL70wAGpx/5IdqsjEw=', 'MxTMJOnItotUeGllI86kYscO0U64OO/HjAK0nuUoclE=', 33),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', 'iEBREzYx2Du4WwJOkFofAfUVZlsHc0UaBV+K8q9zjVw=', 'gFO3yJZ3v2YdNnkdMIe1ezE0jktQIH0BWr6Xp/UPjgo=', 31),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'iIWkAAo+mqXy5H2Gz3ZPLA6IaI4OLL9iHH3S+c0wHmI=', 'oWxIYGiFxbIgtioUfXYU6V4iKbqYrB90R2aMuoX3dRk=', 26),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', 'eP9vDi2yxSISYGd676Lrq6AmonA2ExzmkgH8GdUOBXw=', 'GJagqlb1mev/PfbxN1ZhXaUNj6hkothXd/qMuzeQpGo=', 32),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'MAHL2sTL0LbqRqzm6GmCXDmJoXFf9ltqxW2DkCbtPEQ=', 'y1rsepWqYLMOcj7N5gZX0Ujv5pYLpN+4qImaVyktyTE=', 11),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', '4OMGjljx9Jdi7V5ckPX+QDbipD5f0KOlCK7MV6fMEVM=', '0WsMDp7OdXSjxeuTzM/oJeKRBqCzv0LrMtDFbK/1sB0=', 39),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', '+IGNMc4dcnvHAq9SQGsUwsBQdUEdD1nMez3OEeBjrk4=', 'HceK3NPRigKFLn/3s8+UNoXEQX8lGk1dpoVshz5XWQk=', 20),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', 'YN1/5l4zY7x988wZvNGasgRAGmf8ER+vaNicrFleYkc=', '5AcpHMvS6xfuE2rvy6aj9vUBIubdpFXU68ECwqAkwTQ=', 38),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'EDwQ6a3T4AYCoMy1DAFsi2DMzczKp0K55jzyxOjMeEI=', 'PJGPR1AaM1PUNEE5kuTvFpZ+WNUf3qfbleUahPR7kE8=', 28),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'iBu/8/rUe92m79nm+d9mC0/jTafecYgIDI/kWPTNYWU=', 'PE9PsQtkONsbtEPQDPesh4vsw8VWtfmia2E85onUzU4=', 29),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'eP9uSbejUkSuCan4Mvva+dpJO6ukqpkYWaFdrFqCGlE=', 'QTo+PUbJyeSb0fLu8cwQbkeiMpeZovPJDjGjXxlYgw8=', 17),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'WCwNz6/IKy6Atl4ZmP4Dz97XXaAMfXdfFGkgbiDrb2Y=', 'Yc+SHXY8d6rXuzMJpC+VmcOoV6KNzDSZTcJInZ7p2ho=', 15),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'ICs3sf3gER6CewouFeiXP2zAtrbgxxs3TvIV6VZTm3Q=', 'CpJXrkeXpuG6uqAzCAhg7EzvaFxfFiY+jNKl2aKnHyo=', 16),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'eJdirewpwicESvBzPqBoCUNSfA0PLj7l3f+/aNgCtUc=', '6XjbxQZ2mHHEuV0ugUoi9NghRnd1Rkqzg9M3EuQDNTI=', 27),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'qPZDP7OtdEl0dUePS3T4PRySuJDV0ofzL/z7bhDNVVg=', '/ajMS1YZn2f8mra8Rp6IAuhle/U7LRJWjz/dRyenyRM=', 49),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', '4IZIS2LqqQm94xzEG02GTGoacZTyWcboKMpj1vVpy3s=', 'uMLDSKLnkIQlRAG25Q6DLOISK77x3bPgNGUctol/KSY=', 54),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'AOxhL5jU6o9deXezw5kjcEJGVNcGpRhKVJGsy96Un20=', '3VpiWzgFrvhXeODC4UsJZ07GPF1RP1a8DSZqK2aWuF4=', 46),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'qPqrdqVoAsrHEjUpETpneX6UdC3nXHMxSBbQ4ZWBxnA=', 'ekmCw5P4V7JQFlu5F0Rb6aP+0+DZKZz5dRUYpbCc22U=', 44),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'KD/Qg5N4terCz1IOpXulcFZFJWkdSITVbCqrabnfE0I=', 'Og40dj9uU96Sxvk7PWX+O9k2OxgR1iXTMIitUeB0PFk=', 50),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'KN3Xp1CTtBOQvEykz9Nv4iPm6B2BOlKntqlK7qAbT04=', 'M/OmLi26ERizxXQxwKPN9HzBiSTqjwxscL2WdZgFxSM=', 51),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'oFZEgGdUQqLnAbM1YqKkKHUrlyWkNMlqD4uWByaxkHw=', 'IGAbJ0DhG57ZJ2mDaL9micWioCknXSM+ND7ItwEcX2M=', 34),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', 'oNSimqSkLZrTimia1Qbz8wbLkymCUXUJqOB6QZzvfk0=', 'C5T5ciYEVwIgihYtbd8J22Nh//QPmLQQh/Te7njKWDc=', 40),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'qIaejCLM8DiFqWqGXLGYrzs69oXYPD6irk3O81aOdl4=', 'UDfIiR12s7Nzm23MFm2Pqb7ZXVgzkDGUl2FFcta3s1U=', 45),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'YF2W2KUfBm68i+qixtmIA0eL2V+MunbADedxKGbfm3w=', '/Mu98+HiUxmlW5iYAMbGeKC671iT/LvJEiovfjXMukA=', 24),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'IJXalvCTOxoWbBgqc+kfjI1F/RlFcYfPr989R8gGMHs=', 'vkCAM1j7aqbYv/nEe7/teOmv6vhkTK0xfkVO+LChnjQ=', 37),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'SAVIygtOKAEU9oNftOfZIbZl/QXShOI6qpyItILqK1A=', 'ACbaEa1dlfAzFaChZPEb8bNdX7Ru4wSCz2CmYlrMRAM=', 59),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', 'sOkq0AgDZ/P5tFA7aV7fcsjFGrHCKL9uHyzLA0S2gkw=', 'EL9E6n9l0M7RBTpnAQd9eGsu6YENwro8J5Pd+jcFbF8=', 47),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'gLYqt4aE8X/lTVuWnmedw64Ev7uk3m++pNSHS6KHenU=', 'xPulBNgn5sf/9S7HF1sebc4+yza0i34uPZRTSb/WgGA=', 52),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', '8IYPikRJ1LtxxWUQF0cDYwQESNYr+ugCK4Wc2X/RQVw=', 'Ptw+iPQVsEo7KPOCKedeD/v073IzxzWcrHw/lwcC+Wg=', 42),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', '2HZ43rLvj6BnA0y1Lj7UYW1jp42XphTPWCwv7KjOWks=', '2AibRAzWMaWB8lSxh+N8GPSY6w5cmXcNbuT1kyPLjRk=', 53),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', 'IHzNty3ZbLd+XGm/HcqAkXb75Jqxzv9sa5NjxqEeiVI=', '/3zfAV3EUFDNuH6RQvlffD31FEI1viKUT9uvqMrqhms=', 41),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'iCNVm0p/500iRabJhqpG91a8z3Um9ooU8igRmTykOFM=', 'B9lxsEvtk+fSZWkH4VCRSwQqgnTNHxkW39MPhUpTJ1U=', 56),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'WMrqEC4rXvwjY7ejy9nvrDPZlk9JXrk1C7VOhmkz/FY=', 'k4ZvT9V3iUtpM2pcZ5210Ivt1pCJj4UCJkl/nSBd/hY=', 35),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'yGv5s/lRGwS1fupskV7ryvtJ/15I2QDgdOqMvKtAuWE=', 'awfaoRuJDjPdIbPSECsajpt2pFXZ105mdSLqQ5YXElQ=', 48),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'uDuphqPrzvdjj2u8VzjjbREJhdWNky85PHBFuM+DIVA=', 'QfNTrjew8uZGK7sLWLfbeCa/uCXASj7yZl3WlF+3/l8=', 55),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'qGko3qIxcslngNkAMwdgtk2zpHLz3V96QnTs0rSI508=', 'flqzOF4g/rtCHaT72Pc6gnZAPV5Q/620Xo2dOwztqFc=', 21),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'gKDnV0fdlzEPKQctof8U2HQBDKnEPu95G4lxcdu0X0M=', 'cNm9WA6kj1hMosMNcy5JiwELl3rbfGzO1hyNjRRlZTo=', 57),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', 'wBBIICoMdCLUL/RJ4cHFJZj3GZmgHOujM2DC4U2dUHY=', 'dm1mi2j/+rpGyKFM5lvU8bNSX5n41ZhxDpcD6LidBzw=', 43),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'AODqqot9IIY7eaE9GsA6TaUtiVzh/23fKFmIGrw3E3E=', 'Kc+2VFjw2F1ug+DCPnMaAFzZ7YsMWECqR/J64ZJrcQo=', 60),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'uCJ5wO/Y9MiCfs3KEJ5aqw4+RhX+/PJLQU6Lb319FF0=', '2ixTgG73FDDNZ+fbYiotA718Im2FQSQlyEPa6Ccp4nE=', 23),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:36.43', 'wPFgoMY+2tHZTEayk8Y0CLGHWrtnj6EyHqh4U+iqEUg=', 'aBVjeu7cHCheJ+cymRB6dA/4W0DrONgZogX+coWPrCA=', 30),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.177', 'CHcG8fNtQ2BSDxmYTCwdSVZj9NFe1XQwZ/ZYktEqZFA=', '2sB6XLSxOSI2ch1jk6a6Hg1IXI0DCi1ShoQaOkx0uDo=', 58),
	('910cfaae-ee6c-4f38-9c73-dc8525167a12', 'false', NULL, '2025-10-02 04:59:42.176', 'QJ49OmkL3iPTUbSy64wGkzfjuMS2oZ5WfOmvzzkl/Eg=', 'pLiOIKH87L0qPitOvVFU/4+4Dvfg/Rl3NdSWMbEvCzg=', 36);
/*!40000 ALTER TABLE "pre_keys" ENABLE KEYS */;

-- Copiando estrutura para tabela public.sender_keys
CREATE TABLE IF NOT EXISTS "sender_keys" (
	"id" TEXT NOT NULL,
	"instanceId" TEXT NOT NULL,
	"groupId" TEXT NOT NULL,
	"senderId" TEXT NOT NULL,
	"senderKey" BYTEA NOT NULL,
	"createdAt" TIMESTAMP NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	"updatedAt" TIMESTAMP NOT NULL,
	PRIMARY KEY ("id"),
	UNIQUE INDEX "sender_keys_instanceId_groupId_senderId_key" ("instanceId", "groupId", "senderId")
);

-- Copiando dados para a tabela public.sender_keys: 0 rows
/*!40000 ALTER TABLE "sender_keys" DISABLE KEYS */;
/*!40000 ALTER TABLE "sender_keys" ENABLE KEYS */;

-- Copiando estrutura para tabela public.sessions
CREATE TABLE IF NOT EXISTS "sessions" (
	"instanceId" TEXT NOT NULL,
	"createdAt" TIMESTAMP NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	"updatedAt" TIMESTAMP NOT NULL,
	"device" INTEGER NOT NULL DEFAULT '0',
	"jid" TEXT NOT NULL,
	"record" BYTEA NOT NULL,
	"id" INTEGER NOT NULL DEFAULT 'nextval(''sessions_id_seq''::regclass)',
	PRIMARY KEY ("id"),
	UNIQUE INDEX "sessions_instanceId_jid_device_key" ("instanceId", "jid", "device"),
	CONSTRAINT "sessions_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("instanceId") ON UPDATE CASCADE ON DELETE CASCADE
);

-- Copiando dados para a tabela public.sessions: 0 rows
/*!40000 ALTER TABLE "sessions" DISABLE KEYS */;
/*!40000 ALTER TABLE "sessions" ENABLE KEYS */;

-- Copiando estrutura para tabela public.signed_prekeys
CREATE TABLE IF NOT EXISTS "signed_prekeys" (
	"id" INTEGER NOT NULL,
	"instanceId" TEXT NOT NULL,
	"public" TEXT NOT NULL,
	"private" TEXT NOT NULL,
	"signature" TEXT NOT NULL,
	"timestamp" TIMESTAMP NOT NULL,
	PRIMARY KEY ("id"),
	UNIQUE INDEX "signed_prekeys_instanceId_id_key" ("instanceId", "id"),
	CONSTRAINT "signed_prekeys_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("instanceId") ON UPDATE CASCADE ON DELETE CASCADE
);

-- Copiando dados para a tabela public.signed_prekeys: 0 rows
/*!40000 ALTER TABLE "signed_prekeys" DISABLE KEYS */;
/*!40000 ALTER TABLE "signed_prekeys" ENABLE KEYS */;

-- Copiando estrutura para tabela public._prisma_migrations
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
	"id" VARCHAR(36) NOT NULL,
	"checksum" VARCHAR(64) NOT NULL,
	"finished_at" TIMESTAMPTZ NULL DEFAULT NULL,
	"migration_name" VARCHAR(255) NOT NULL,
	"logs" TEXT NULL DEFAULT NULL,
	"rolled_back_at" TIMESTAMPTZ NULL DEFAULT NULL,
	"started_at" TIMESTAMPTZ NOT NULL DEFAULT 'now()',
	"applied_steps_count" INTEGER NOT NULL DEFAULT '0',
	PRIMARY KEY ("id")
);

-- Copiando dados para a tabela public._prisma_migrations: 6 rows
/*!40000 ALTER TABLE "_prisma_migrations" DISABLE KEYS */;
INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count") VALUES
	('6f52e319-dcc8-461d-9af6-70be1725b7e4', '15ecf4354fff50519963ce29f864bc6e71585869fcdbd66da62abe05d8aad889', '2025-10-02 00:49:22.698169-03', '20250929200917_init', NULL, NULL, '2025-10-02 00:49:22.62766-03', 1),
	('1448e3aa-22fa-42a3-ae0d-b61d05f64ee9', '6451fa2664718ea2344478597500c693a6ed93d1f5f7bd42805da92033f79323', '2025-10-02 00:49:22.706926-03', '20251001031906_update_session_table_for_baileys_format', NULL, NULL, '2025-10-02 00:49:22.698737-03', 1),
	('231859ee-3a25-4a5b-bc12-7496195741cb', '6911b64a4527687212190dc4fe75b4db7eb136fc02254454fdc4b1abde1980be', '2025-10-02 00:49:22.723988-03', '20251001145811_fix_session_model', NULL, NULL, '2025-10-02 00:49:22.707715-03', 1),
	('660aba7b-4589-4b82-b3cb-d783269ae11d', 'de156e8c3e6e811ef119f9641fac557f56d71d1ceb3d1bbcd369c775fba73b7c', '2025-10-02 00:49:22.726681-03', '20251001150223_add_session_data_field', NULL, NULL, '2025-10-02 00:49:22.724568-03', 1),
	('20d96293-d188-41fa-8668-52242b53bb33', 'c3bd03b982d5635e69faecd3b2d93099df9a260c632f386af4d7d599598b7df7', '2025-10-02 00:49:22.729758-03', '20251001152701_change_session_data_to_json', NULL, NULL, '2025-10-02 00:49:22.72722-03', 1),
	('441006e7-ebad-44e1-aba7-eead1c9c2fe2', '759586ec1e4ad145658e361f7d297d96f6658940bec0a6a690ef33e042407434', '2025-10-02 00:49:22.821549-03', '20251002030117_whatsmeow_structure', NULL, NULL, '2025-10-02 00:49:22.730569-03', 1);
/*!40000 ALTER TABLE "_prisma_migrations" ENABLE KEYS */;

/*!40103 SET TIME_ZONE=IFNULL(@OLD_TIME_ZONE, 'system') */;
/*!40101 SET SQL_MODE=IFNULL(@OLD_SQL_MODE, '') */;
/*!40014 SET FOREIGN_KEY_CHECKS=IFNULL(@OLD_FOREIGN_KEY_CHECKS, 1) */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40111 SET SQL_NOTES=IFNULL(@OLD_SQL_NOTES, 1) */;
