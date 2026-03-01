import { PerformanceTracker } from "@/common/performance";

declare global {
  interface Window {
    tracker: PerformanceTracker;
  }
  // 声明全局 tracker 变量，指向 window.tracker
  const tracker: PerformanceTracker;
}
