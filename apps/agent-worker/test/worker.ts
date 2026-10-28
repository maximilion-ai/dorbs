import { makeAcpConnection } from "../src/AcpConnection.ts";
import * as ScriptedModel from "./ScriptedModel.ts";

export { default } from "../src/worker.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}

export class AcpConnection extends makeAcpConnection(() => ScriptedModel.layer) {}
