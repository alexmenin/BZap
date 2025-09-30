-- CreateTable
CREATE TABLE "public"."instances" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "nameDevice" TEXT,
    "numberDevice" TEXT,
    "webhookUrl" TEXT,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "noiseKeyPrivate" BYTEA,
    "noiseKeyPublic" BYTEA,
    "pairingEphemeralKeyPrivate" BYTEA,
    "pairingEphemeralKeyPublic" BYTEA,
    "signedIdentityKeyPrivate" BYTEA,
    "signedIdentityKeyPublic" BYTEA,
    "signedPreKeyId" INTEGER,
    "signedPreKeyPrivate" BYTEA,
    "signedPreKeyPublic" BYTEA,
    "signedPreKeySignature" BYTEA,
    "registrationId" INTEGER,
    "advSecretKey" TEXT,
    "nextPreKeyId" INTEGER NOT NULL DEFAULT 1,
    "firstUnuploadedPreKeyId" INTEGER NOT NULL DEFAULT 1,
    "serverHasPreKeys" BOOLEAN NOT NULL DEFAULT false,
    "processedHistoryMessages" JSONB NOT NULL DEFAULT '[]',
    "accountSyncCounter" INTEGER NOT NULL DEFAULT 0,
    "accountSettings" JSONB NOT NULL DEFAULT '{"unarchiveChats": false}',
    "registered" BOOLEAN NOT NULL DEFAULT false,
    "pairingCode" TEXT,
    "lastPropHash" TEXT,
    "routingInfo" BYTEA,
    "userId" TEXT,
    "userName" TEXT,
    "userLid" TEXT,
    "signalIdentities" JSONB NOT NULL DEFAULT '[]',
    "myAppStateKeyId" TEXT,
    "lastAccountSyncTimestamp" BIGINT,
    "platform" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastAccess" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."pre_keys" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "keyId" INTEGER NOT NULL,
    "privateKey" BYTEA NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pre_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sessions" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionData" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sender_keys" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderKey" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sender_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."app_state_sync_keys" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "keyData" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_state_sync_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."app_state_versions" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "hash" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_state_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."connection_logs" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT,
    "message" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."message_logs" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "messageId" TEXT,
    "fromJid" TEXT,
    "toJid" TEXT,
    "messageType" TEXT,
    "content" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instances_instanceId_key" ON "public"."instances"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "pre_keys_instanceId_keyId_key" ON "public"."pre_keys"("instanceId", "keyId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_instanceId_sessionId_key" ON "public"."sessions"("instanceId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "sender_keys_instanceId_groupId_senderId_key" ON "public"."sender_keys"("instanceId", "groupId", "senderId");

-- CreateIndex
CREATE UNIQUE INDEX "app_state_sync_keys_instanceId_keyId_key" ON "public"."app_state_sync_keys"("instanceId", "keyId");

-- CreateIndex
CREATE UNIQUE INDEX "app_state_versions_instanceId_name_key" ON "public"."app_state_versions"("instanceId", "name");

-- AddForeignKey
ALTER TABLE "public"."pre_keys" ADD CONSTRAINT "pre_keys_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "public"."instances"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sessions" ADD CONSTRAINT "sessions_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "public"."instances"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."connection_logs" ADD CONSTRAINT "connection_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "public"."instances"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."message_logs" ADD CONSTRAINT "message_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "public"."instances"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;
