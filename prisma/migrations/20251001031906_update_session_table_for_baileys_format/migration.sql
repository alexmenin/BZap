/*
  Warnings:

  - You are about to drop the column `sessionId` on the `sessions` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[instanceId]` on the table `sessions` will be added. If there are existing duplicate values, this will fail.
  - Changed the type of `sessionData` on the `sessions` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropIndex
DROP INDEX "public"."sessions_instanceId_sessionId_key";

-- AlterTable
ALTER TABLE "public"."sessions" DROP COLUMN "sessionId",
DROP COLUMN "sessionData",
ADD COLUMN     "sessionData" JSONB NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "sessions_instanceId_key" ON "public"."sessions"("instanceId");
