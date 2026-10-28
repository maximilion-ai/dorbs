import { RepoId } from "@dorbs/protocol/typecheck";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** The repos clone_repo may clone: their HTTPS urls by id, as the typecheck service registers them. */
export class Repos extends Context.Service<Repos, ReadonlyMap<RepoId, string>>()(
  "dorbs/agent-worker/Repos",
) {}

const ReposJson = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: RepoId, url: Schema.NonEmptyString })),
);

/** Reads REPOS, a JSON array of `{ "id": "owner/name", "url": "https://..." }`. */
export const layer = Layer.effect(
  Repos,
  Config.schema(ReposJson, "REPOS").pipe(
    Effect.map((repos) => new Map(repos.map((repo) => [repo.id, repo.url]))),
  ),
);
