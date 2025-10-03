-- AlterTable
ALTER TABLE "public"."credentials" ADD COLUMN     "companionKey" TEXT;

-- AlterTable
ALTER TABLE "public"."instances" ALTER COLUMN "events" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "public"."sender_keys" ADD CONSTRAINT "sender_keys_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "public"."instances"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."app_state_versions" ADD CONSTRAINT "app_state_versions_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "public"."instances"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;
