/*
  Warnings:

  - You are about to drop the column `accountSettings` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `accountSyncCounter` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `advSecretKey` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `firstUnuploadedPreKeyId` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `lastAccountSyncTimestamp` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `lastPropHash` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `myAppStateKeyId` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `nextPreKeyId` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `noiseKeyPrivate` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `noiseKeyPublic` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `pairingCode` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `pairingEphemeralKeyPrivate` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `pairingEphemeralKeyPublic` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `processedHistoryMessages` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `registered` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `registrationId` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `routingInfo` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `serverHasPreKeys` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `sessionData` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `signalIdentities` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `signedIdentityKeyPrivate` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `signedIdentityKeyPublic` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `signedPreKeyId` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `signedPreKeyPrivate` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `signedPreKeyPublic` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `signedPreKeySignature` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `userLid` on the `instances` table. All the data in the column will be lost.
  - You are about to drop the column `userName` on the `instances` table. All the data in the column will be lost.
  - The primary key for the `pre_keys` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `keyId` on the `pre_keys` table. All the data in the column will be lost.
  - You are about to drop the column `privateKey` on the `pre_keys` table. All the data in the column will be lost.
  - You are about to drop the column `publicKey` on the `pre_keys` table. All the data in the column will be lost.
  - The primary key for the `sessions` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `sessionData` on the `sessions` table. All the data in the column will be lost.
  - You are about to drop the column `sessionId` on the `sessions` table. All the data in the column will be lost.
  - The `id` column on the `sessions` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `app_state_sync_keys` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[instanceId,id]` on the table `pre_keys` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[instanceId,jid,device]` on the table `sessions` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `private` to the `pre_keys` table without a default value. This is not possible if the table is not empty.
  - Added the required column `public` to the `pre_keys` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `id` on the `pre_keys` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `jid` to the `sessions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `record` to the `sessions` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "public"."pre_keys_instanceId_keyId_key";

-- DropIndex
DROP INDEX "public"."sessions_instanceId_sessionId_key";

-- AlterTable
ALTER TABLE "public"."instances" DROP COLUMN "accountSettings",
DROP COLUMN "accountSyncCounter",
DROP COLUMN "advSecretKey",
DROP COLUMN "firstUnuploadedPreKeyId",
DROP COLUMN "lastAccountSyncTimestamp",
DROP COLUMN "lastPropHash",
DROP COLUMN "myAppStateKeyId",
DROP COLUMN "nextPreKeyId",
DROP COLUMN "noiseKeyPrivate",
DROP COLUMN "noiseKeyPublic",
DROP COLUMN "pairingCode",
DROP COLUMN "pairingEphemeralKeyPrivate",
DROP COLUMN "pairingEphemeralKeyPublic",
DROP COLUMN "processedHistoryMessages",
DROP COLUMN "registered",
DROP COLUMN "registrationId",
DROP COLUMN "routingInfo",
DROP COLUMN "serverHasPreKeys",
DROP COLUMN "sessionData",
DROP COLUMN "signalIdentities",
DROP COLUMN "signedIdentityKeyPrivate",
DROP COLUMN "signedIdentityKeyPublic",
DROP COLUMN "signedPreKeyId",
DROP COLUMN "signedPreKeyPrivate",
DROP COLUMN "signedPreKeyPublic",
DROP COLUMN "signedPreKeySignature",
DROP COLUMN "userId",
DROP COLUMN "userLid",
DROP COLUMN "userName";

-- AlterTable
ALTER TABLE "public"."pre_keys" DROP CONSTRAINT "pre_keys_pkey",
DROP COLUMN "keyId",
DROP COLUMN "privateKey",
DROP COLUMN "publicKey",
ADD COLUMN     "private" TEXT NOT NULL,
ADD COLUMN     "public" TEXT NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" INTEGER NOT NULL,
ADD CONSTRAINT "pre_keys_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "public"."sessions" DROP CONSTRAINT "sessions_pkey",
DROP COLUMN "sessionData",
DROP COLUMN "sessionId",
ADD COLUMN     "device" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "jid" TEXT NOT NULL,
ADD COLUMN     "record" BYTEA NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "sessions_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "public"."app_state_sync_keys";

-- CreateTable
CREATE TABLE "public"."credentials" (
    "instanceId" TEXT NOT NULL,
    "registrationId" INTEGER NOT NULL,
    "noiseKey" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "advSecretKey" TEXT,
    "signedPreKeyId" INTEGER,
    "signedPreKeyPub" TEXT,
    "signedPreKeyPriv" TEXT,
    "signedPreKeySig" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("instanceId")
);

-- CreateTable
CREATE TABLE "public"."identities" (
    "id" SERIAL NOT NULL,
    "instanceId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "trustLevel" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."signed_prekeys" (
    "id" INTEGER NOT NULL,
    "instanceId" TEXT NOT NULL,
    "public" TEXT NOT NULL,
    "private" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signed_prekeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."app_state_keys" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "keyData" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_state_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identities_instanceId_jid_key" ON "public"."identities"("instanceId", "jid");

-- CreateIndex
CREATE UNIQUE INDEX "signed_prekeys_instanceId_id_key" ON "public"."signed_prekeys"("instanceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "app_state_keys_instanceId_keyId_key" ON "public"."app_state_keys"("instanceId", "keyId");

-- CreateIndex
CREATE UNIQUE INDEX "pre_keys_instanceId_id_key" ON "public"."pre_keys"("instanceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_instanceId_jid_device_key" ON "public"."sessions"("instanceId", "jid", "device");

-- AddForeignKey
ALTER TABLE "public"."credentials" ADD CONSTRAINT "credentials_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "public"."instances"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."identities" ADD CONSTRAINT "identities_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "public"."instances"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."signed_prekeys" ADD CONSTRAINT "signed_prekeys_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "public"."instances"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."app_state_keys" ADD CONSTRAINT "app_state_keys_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "public"."instances"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;
