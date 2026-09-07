-- AlterTable
ALTER TABLE "AnalyticsEvent" ADD COLUMN "eventKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsEvent_eventKey_key" ON "AnalyticsEvent"("eventKey");
