/**
 * MeshAPI singleton — cross-instance capability.
 *
 * State stored on globalThis (key {@link MESH_GLOBAL_KEY}) to survive module
 * identity mismatches (extension loaded by absolute path vs import via workspace
 * symlink). Consumers (pi-peek-agent, a future chat-room) import getMeshAPI()
 * for typed access; they never touch globalThis.
 *
 * The internal `route` returned by initMeshAPI() is glue for the extension
 * entrypoint's UDS server — it dispatches an incoming typed request to the
 * handler registered via serve(). It is deliberately NOT part of the public
 * MeshAPI surface.
 */

import { connectPeer } from "./ipc.ts";
import * as discovery from "./discovery.ts";
import type {
  EmitFn,
  MeshAPI,
  MeshConfig,
  MeshConnection,
  PeerInfo,
  ResolvePeerOptions,
  ServeHandler,
} from "./types.ts";
import { MESH_GLOBAL_KEY, MAX_SESSION_NAME_LENGTH } from "./types.ts";

export interface MeshDeps {
  /** This instance's base identity (sessionId/pid/sockPath/name/cwd/model/since). */
  self: PeerInfo;
  /** Resolved config (already merged with defaults). */
  config: MeshConfig;
  /** Registry directory for PID-file markers. */
  registryDir: string;
}

/**
 * @internal Extension-entrypoint glue: the public MeshAPI plus the server
 * request router. The router is consumed only by index.ts's startMeshServer.
 */
export interface MeshAPIInternal {
  api: MeshAPI;
  /** Dispatch an incoming request to the handler registered for `type`. */
  route(type: string, data: unknown, emit: EmitFn): Promise<unknown>;
}

export function initMeshAPI(deps: MeshDeps): MeshAPIInternal {
  const state = {
    // Clone so identity/profile mutations don't leak back to the caller.
    self: { ...deps.self } as PeerInfo,
    registryDir: deps.registryDir,
  };
  const serveHandlers = new Map<string, ServeHandler>();

  const api: MeshAPI = {
    updateModel(modelId: string): void {
      state.self.model = modelId;
    },

    updateSessionName(name: string | undefined): void {
      // pi already collapses newlines in session names; mesh only caps the length.
      const n = name?.trim();
      state.self.sessionName = !n
        ? undefined
        : n.length > MAX_SESSION_NAME_LENGTH
          ? `${n.slice(0, MAX_SESSION_NAME_LENGTH - 1)}…`
          : n;
    },

    setName(name: string): void {
      if (name) state.self.name = name;
    },

    setProfile(p: Partial<{ role: string; description: string }>): void {
      const prev = state.self.profile ?? {};
      // undefined ⇒ keep; "" ⇒ clear; otherwise overwrite.
      const role = p.role !== undefined ? p.role || undefined : prev.role;
      const description =
        p.description !== undefined ? p.description || undefined : prev.description;
      state.self.profile = role || description ? { role, description } : undefined;
    },

    getProfile() {
      return state.self.profile;
    },

    getSelfInfo(): PeerInfo {
      return { ...state.self, lastSeen: new Date().toISOString() };
    },

    async listPeers(): Promise<PeerInfo[]> {
      const candidates = discovery.listPeersFromRegistry(
        state.registryDir,
        state.self.sessionId,
      );
      const peers = await discovery.pruneDeadPeers(candidates);
      discovery.flagAmbiguous(peers);
      return discovery.sortByProject(peers, state.self.cwd);
    },

    async resolvePeer(
      opts: ResolvePeerOptions = {},
    ): Promise<PeerInfo | PeerInfo[] | undefined> {
      const peers = await api.listPeers();
      if (opts.sessionId) {
        return peers.find((p) => p.sessionId === opts.sessionId);
      }
      if (opts.at) {
        const named = peers.filter((p) => p.name === opts.at);
        if (named.length === 0) return undefined;
        if (named.length === 1) return named[0];
        return named; // ambiguous
      }
      // Auto: pick another peer in the same project.
      const sameProject = peers.filter(
        (p) => p.cwd === state.self.cwd && p.sessionId !== state.self.sessionId,
      );
      return sameProject[0];
    },

    async countPeers(): Promise<number> {
      return (await api.listPeers()).length;
    },

    serve(type: string, handler: ServeHandler): void {
      serveHandlers.set(type, handler);
    },

    async connect(peer: PeerInfo): Promise<MeshConnection> {
      return connectPeer(peer.sockPath);
    },
  };

  const internal: MeshAPIInternal = {
    api,
    route(type, data, emit) {
      const h = serveHandlers.get(type);
      if (!h) throw new Error(`mesh: no handler registered for type "${type}"`);
      return h(data, emit);
    },
  };

  (globalThis as any)[MESH_GLOBAL_KEY] = api;
  return internal;
}

/** Get the initialized MeshAPI. Throws if initMeshAPI() hasn't run. */
export function getMeshAPI(): MeshAPI {
  const api = (globalThis as any)[MESH_GLOBAL_KEY] as MeshAPI | undefined;
  if (!api) {
    throw new Error(
      "MeshAPI not initialized. Ensure @d3ara1n/pi-mesh extension is loaded and session_start has fired.",
    );
  }
  return api;
}

/** Non-throwing getter (for hooks that fire before session_start). */
export function tryGetMeshAPI(): MeshAPI | undefined {
  return (globalThis as any)[MESH_GLOBAL_KEY] as MeshAPI | undefined;
}
