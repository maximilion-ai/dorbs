import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Layer from "effect/Layer";

import * as AcpMux from "./AcpMux.ts";

Layer.launch(AcpMux.layer).pipe(NodeRuntime.runMain);
