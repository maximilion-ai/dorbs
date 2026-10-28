export { AcpConnection, AcpSession, default } from "../src/worker.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}
