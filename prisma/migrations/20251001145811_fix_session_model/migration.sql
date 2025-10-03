/*
  Warnings:

  - A unique constraint covering the columns `[instanceId,sessionId]` on the table `sessions` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `sessionId` to the `sessions` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "public"."sessions_instanceId_key";

-- AlterTable
ALTER TABLE "public"."sessions" ADD COLUMN     "sessionId" TEXT NOT NULL,
ALTER COLUMN "sessionData" SET DATA TYPE TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "sessions_instanceId_sessionId_key" ON "public"."sessions"("instanceId", "sessionId");
