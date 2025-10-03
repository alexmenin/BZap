/*
  Warnings:

  - Changed the type of `record` on the `sessions` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "public"."sessions" DROP COLUMN "record",
ADD COLUMN     "record" JSONB NOT NULL;
