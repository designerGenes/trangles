// Trangles' Cloudflare Worker. There is deliberately almost nothing here:
// the Go binary in the container already owns routing, static files,
// WebSockets, and config serving, so this file's only job is to hand every
// request to the one running instance. Container.fetch() forwards WebSocket
// upgrade requests automatically — see
// https://developers.cloudflare.com/containers/examples/websocket/ — so
// static pages, /api/config, /resources, /healthz, and the /ws socket all
// travel the same path without this file knowing the difference.
import { Container, getContainer } from "@cloudflare/containers";
// Only needed if you uncomment envVars below — see DEPLOY.md.
// import { env } from "cloudflare:workers";

export class TranglesContainer extends Container {
  defaultPort = 8080;
  // A live round can sit idle between submissions; a cold start mid-round
  // would drop every open WebSocket in the room. 30 minutes covers a normal
  // pointing session with room to spare — see roundSubmitEstimate flows in
  // session.go for why a room can go quiet for a while without being done.
  sleepAfter = "30m";

  // Uncomment (and the cloudflare:workers import above) to forward a secret
  // into the container — see DEPLOY.md for the matching `wrangler secret
  // put` step. Left off because the app runs correctly without it;
  // cache.go already treats REDIS_URL as optional.
  //
  // envVars = {
  //   REDIS_URL: env.REDIS_URL,
  // };
}

export default {
  async fetch(request, env) {
    // A single named instance, always the same one — see the max_instances
    // comment in wrangler.jsonc for why this app cannot yet load-balance
    // across containers. Naming it (rather than using the no-argument
    // default) makes that a documented choice instead of an accident of
    // whichever helper happened to be used.
    return getContainer(env.TRANGLES_CONTAINER, "primary").fetch(request);
  },
};
